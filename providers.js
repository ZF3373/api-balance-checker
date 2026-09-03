'use strict';

const crypto = require('crypto');

/**
 * 按 dot 路径从对象中取值，支持数组下标（如 balance_infos.0.total_balance）
 */
function getByPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, obj);
}

/**
 * 带超时的 fetch 封装
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 生成智谱 API 鉴权 JWT（API Key 格式为 {id}.{secret}）
 */
function generateZhipuJWT(apiKey) {
  const parts = apiKey.split('.');
  if (parts.length !== 2) {
    throw new Error('智谱 API Key 格式应为 {id}.{secret}');
  }
  const [id, secret] = parts;
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', sign_type: 'SIGN' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    api_key: id,
    exp: Math.floor(Date.now() / 1000) + 3600,
    timestamp: Math.floor(Date.now() / 1000),
  })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/**
 * 读取响应并尝试解析 JSON；若非 JSON 返回 null
 */
async function tryJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 规范化 baseUrl：去除尾部斜杠和多余的 /v1 后缀，
 * 使多策略余额查询可以直接拼接 /v1/... 路径
 */
function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * 解析 Key 条目的有效 baseUrl：
 * 优先用用户填写的 baseUrl（trim），留空时回退到提供商默认值。
 * main.js 与 proxy.js 共用，避免两处手写不一致。
 */
function resolveBaseUrl(keyEntry) {
  const base = (keyEntry.baseUrl || '').trim();
  if (base) return base;
  const provider = PROVIDERS[(keyEntry || {}).provider];
  return (provider && provider.defaultBaseUrl) || '';
}

/**
 * 统一错误消息：AbortError → 请求超时，其余取 message 或字符串。
 * 供 main.js / proxy.js 所有 catch 块复用。
 */
function toErrorMessage(err) {
  if (!err) return '未知错误';
  return err.name === 'AbortError' ? '请求超时' : (err.message || String(err));
}

/**
 * 通用余额查询骨架：fetch → 校验状态 → 解析 JSON → 提取字段。
 * 各 provider 只需提供 url、headers 和 getValue 提取函数。
 */
async function fetchBalance(url, { headers, timeoutMs = 15000, getValue } = {}) {
  const res = await fetchWithTimeout(url, { headers }, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await tryJson(res);
  if (!json) throw new Error('响应非 JSON');
  return getValue(json);
}

/**
 * OpenAI 兼容平台的多策略余额查询（供中转站等接口未知的平台使用）。
 * 依次尝试已知的余额查询接口，命中即返回。
 */
async function queryCompatibleBalance(baseUrl, apiKey) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const root = normalizeBaseUrl(baseUrl);

  // 策略一：credit_grants 直接返回可用额度（One-API / New-API 等）
  try {
    const res = await fetchWithTimeout(`${root}/v1/dashboard/billing/credit_grants`, { headers });
    if (res.ok) {
      const json = await tryJson(res);
      if (json) {
        if (json.total_available != null) {
          return { balance: parseFloat(json.total_available), currency: 'USD', raw: json };
        }
        if (json.total_granted != null && json.total_used != null) {
          return { balance: parseFloat(json.total_granted) - parseFloat(json.total_used), currency: 'USD', raw: json };
        }
      }
    }
  } catch { /* 继续下一个策略 */ }

  // 策略二：subscription + usage 计算剩余额度（OpenAI 原生风格）
  try {
    const subRes = await fetchWithTimeout(`${root}/v1/dashboard/billing/subscription`, { headers });
    if (subRes.ok) {
      const sub = await tryJson(subRes);
      if (sub) {
        const hardLimit = parseFloat(sub.hard_limit ?? 0);
        const now = new Date();
        const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        const end = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const usageRes = await fetchWithTimeout(
          `${root}/v1/dashboard/billing/usage?start_date=${start}&end_date=${end}`,
          { headers },
        );
        if (usageRes.ok) {
          const usage = await tryJson(usageRes);
          if (usage) {
            const used = parseFloat(usage.total_usage ?? 0) / 100; // 分 → 元
            return { balance: hardLimit - used, currency: 'USD', raw: { subscription: sub, usage } };
          }
        }
      }
    }
  } catch { /* 继续下一个策略 */ }

  // 策略三：users/me/balance（月之暗面 / Moonshot 风格）
  try {
    const res = await fetchWithTimeout(`${root}/v1/users/me/balance`, { headers });
    if (res.ok) {
      const json = await tryJson(res);
      if (json) {
        const d = json.data || json;
        if (d.available_balance != null) {
          return { balance: parseFloat(d.available_balance), currency: 'CNY', raw: json };
        }
        if (d.balance != null) {
          return { balance: parseFloat(d.balance), currency: 'CNY', raw: json };
        }
      }
    }
  } catch { /* 继续下一个策略 */ }

  // 策略四：user/info（硅基流动风格）
  try {
    const res = await fetchWithTimeout(`${root}/v1/user/info`, { headers });
    if (res.ok) {
      const json = await tryJson(res);
      if (json) {
        const d = json.data || json;
        if (d.balance != null) {
          return { balance: parseFloat(d.balance), currency: 'CNY', raw: json };
        }
      }
    }
  } catch { /* 继续下一个策略 */ }

  throw new Error('该平台不支持余额查询接口，请尝试「自定义」类型');
}

/**
 * 用于已知没有公开余额查询 API 的国内平台。
 * 余额查询会直接返回提示，不影响 API Key 聚合代理功能。
 */
async function unsupportedBalance(providerName) {
  throw new Error(`${providerName} 暂不支持余额查询（不影响 API 聚合代理）`);
}

// ────────────────────── 提供商定义 ──────────────────────

const PROVIDERS = {
  // DeepSeek 官方 — 余额接口：GET /user/balance
  deepseek: {
    name: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    currency: 'CNY',
    async queryBalance(baseUrl, apiKey) {
      return fetchBalance(`${baseUrl}/user/balance`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        getValue: (json) => {
          const info = (json.balance_infos && json.balance_infos[0]) || {};
          return {
            balance: parseFloat(info.total_balance ?? '0'),
            currency: info.currency || 'CNY',
            raw: json,
          };
        },
      });
    },
  },

  // 智谱 GLM — 余额接口：GET /api/billing/v1/current-balance（需 JWT 鉴权）
  zhipu: {
    name: '智谱',
    defaultBaseUrl: 'https://open.bigmodel.cn',
    currency: 'CNY',
    async queryBalance(baseUrl, apiKey) {
      const token = generateZhipuJWT(apiKey);
      return fetchBalance(`${baseUrl}/api/billing/v1/current-balance`, {
        headers: { Authorization: `Bearer ${token}` },
        getValue: (json) => {
          const d = json.data || json;
          return {
            balance: parseFloat(d.balance ?? '0'),
            currency: 'CNY',
            raw: json,
          };
        },
      });
    },
  },

  // 硅基流动 SiliconFlow — 余额接口：GET /v1/user/info
  siliconflow: {
    name: '硅基流动',
    defaultBaseUrl: 'https://api.siliconflow.cn',
    currency: 'CNY',
    async queryBalance(baseUrl, apiKey) {
      return fetchBalance(`${baseUrl}/v1/user/info`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        getValue: (json) => {
          const d = json.data || {};
          return {
            balance: parseFloat(d.balance ?? '0'),
            currency: 'CNY',
            raw: json,
          };
        },
      });
    },
  },

  // 月之暗面 Moonshot / Kimi — 余额接口：GET /v1/users/me/balance
  moonshot: {
    name: '月之暗面 (Kimi)',
    defaultBaseUrl: 'https://api.moonshot.cn',
    currency: 'CNY',
    async queryBalance(baseUrl, apiKey) {
      return fetchBalance(`${baseUrl}/v1/users/me/balance`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        getValue: (json) => {
          const d = json.data || json;
          return {
            balance: parseFloat(d.available_balance ?? d.balance ?? '0'),
            currency: 'CNY',
            raw: json,
          };
        },
      });
    },
  },

  // OpenRouter — 余额接口：GET /api/v1/auth/key
  openrouter: {
    name: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai',
    currency: 'USD',
    async queryBalance(baseUrl, apiKey) {
      return fetchBalance(`${baseUrl}/api/v1/auth/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        getValue: (json) => {
          const d = json.data || {};
          const limit = parseFloat(d.limit ?? '0');
          const usage = parseFloat(d.usage ?? '0');
          return {
            balance: limit - usage,
            currency: 'USD',
            raw: json,
          };
        },
      });
    },
  },

  // ── 以下国内平台暂无公开的余额查询 API，仅用于 API Key 聚合代理 ──
  // 余额查询会返回提示，不影响代理转发功能。

  // MiniMax
  minimax: {
    name: 'MiniMax',
    defaultBaseUrl: 'https://api.minimax.chat',
    currency: 'CNY',
    async queryBalance() {
      return unsupportedBalance('MiniMax');
    },
  },

  // 零一万物 01.AI
  lingyiwanwu: {
    name: '零一万物',
    defaultBaseUrl: 'https://api.lingyiwanwu.com',
    currency: 'CNY',
    async queryBalance() {
      return unsupportedBalance('零一万物');
    },
  },

  // 百川智能 Baichuan
  baichuan: {
    name: '百川智能',
    defaultBaseUrl: 'https://api.baichuan-ai.com',
    currency: 'CNY',
    async queryBalance() {
      return unsupportedBalance('百川智能');
    },
  },

  // 阿里云百炼 / 通义千问 DashScope
  dashscope: {
    name: '阿里云百炼 (通义千问)',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com',
    currency: 'CNY',
    async queryBalance() {
      return unsupportedBalance('阿里云百炼');
    },
  },

  // 火山引擎 / 豆包 Volcengine Ark
  volcengine: {
    name: '火山引擎 (豆包)',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com',
    currency: 'CNY',
    async queryBalance() {
      return unsupportedBalance('火山引擎');
    },
  },

  // 百度千帆 / 文心一言 Baidu Qianfan
  qianfan: {
    name: '百度千帆 (文心一言)',
    defaultBaseUrl: 'https://qianfan.baidubce.com',
    currency: 'CNY',
    async queryBalance() {
      return unsupportedBalance('百度千帆');
    },
  },

  // 腾讯混元 Tencent Hunyuan
  hunyuan: {
    name: '腾讯混元',
    defaultBaseUrl: 'https://api.hunyuan.cloud.tencent.com',
    currency: 'CNY',
    async queryBalance() {
      return unsupportedBalance('腾讯混元');
    },
  },

  // 基元律动 TokenRhythm
  tokenrhythm: {
    name: '基元律动',
    defaultBaseUrl: 'https://tokenrhythm.studio',
    currency: 'CNY',
    async queryBalance() {
      return unsupportedBalance('基元律动');
    },
  },

  // OpenAI 兼容中转站（One-API / New-API 等）— 接口未知，多策略自动探测
  relay: {
    name: '中转站(OpenAI兼容)',
    defaultBaseUrl: '',
    currency: 'USD',
    async queryBalance(baseUrl, apiKey) {
      return queryCompatibleBalance(baseUrl, apiKey);
    },
  },

  // 自定义：用户指定路径和 JSON 提取路径
  custom: {
    name: '自定义',
    defaultBaseUrl: '',
    currency: '',
    async queryBalance(baseUrl, apiKey, extra = {}) {
      const path = (extra.customBalancePath || '').replace(/^\//, '');
      const url = `${baseUrl.replace(/\/$/, '')}/${path}`;
      return fetchBalance(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        getValue: (json) => {
          const val = getByPath(json, extra.customJsonPath);
          if (val == null) throw new Error(`JSON 路径 "${extra.customJsonPath}" 未找到值`);
          return {
            balance: parseFloat(val),
            currency: extra.customCurrency || '',
            raw: json,
          };
        },
      });
    },
  },
};

// 供下拉菜单使用的有序列表
const PROVIDER_LIST = Object.entries(PROVIDERS).map(([key, p]) => ({
  key,
  name: p.name,
  defaultBaseUrl: p.defaultBaseUrl,
  currency: p.currency,
  isCustom: key === 'custom',
}));

module.exports = {
  PROVIDERS,
  PROVIDER_LIST,
  getByPath,
  normalizeBaseUrl,
  resolveBaseUrl,
  toErrorMessage,
  fetchWithTimeout,
  tryJson,
};
