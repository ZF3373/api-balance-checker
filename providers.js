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

// ────────────────────── 提供商定义 ──────────────────────

const PROVIDERS = {
  // DeepSeek 官方
  deepseek: {
    name: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    currency: 'CNY',
    async queryBalance(baseUrl, apiKey) {
      const res = await fetchWithTimeout(`${baseUrl}/user/balance`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await tryJson(res);
      if (!json) throw new Error('响应非 JSON');
      const info = (json.balance_infos && json.balance_infos[0]) || {};
      return {
        balance: parseFloat(info.total_balance ?? '0'),
        currency: info.currency || 'CNY',
        raw: json,
      };
    },
  },

  // OpenRouter
  openrouter: {
    name: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai',
    currency: 'USD',
    async queryBalance(baseUrl, apiKey) {
      const res = await fetchWithTimeout(`${baseUrl}/api/v1/auth/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await tryJson(res);
      if (!json) throw new Error('响应非 JSON');
      const d = json.data || {};
      const limit = parseFloat(d.limit ?? '0');
      const usage = parseFloat(d.usage ?? '0');
      return {
        balance: limit - usage,
        currency: 'USD',
        raw: json,
      };
    },
  },

  // 硅基流动 SiliconFlow
  siliconflow: {
    name: '硅基流动',
    defaultBaseUrl: 'https://api.siliconflow.cn',
    currency: 'CNY',
    async queryBalance(baseUrl, apiKey) {
      const res = await fetchWithTimeout(`${baseUrl}/v1/user/info`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await tryJson(res);
      if (!json) throw new Error('响应非 JSON');
      const d = json.data || {};
      return {
        balance: parseFloat(d.balance ?? '0'),
        currency: 'CNY',
        raw: json,
      };
    },
  },

  // 智谱 GLM
  zhipu: {
    name: '智谱',
    defaultBaseUrl: 'https://open.bigmodel.cn',
    currency: 'CNY',
    async queryBalance(baseUrl, apiKey) {
      const token = generateZhipuJWT(apiKey);
      const res = await fetchWithTimeout(`${baseUrl}/api/billing/v1/current-balance`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await tryJson(res);
      if (!json) throw new Error('响应非 JSON');
      const d = json.data || json;
      return {
        balance: parseFloat(d.balance ?? '0'),
        currency: 'CNY',
        raw: json,
      };
    },
  },

  // OpenAI 兼容中转站（One-API / New-API 等）
  relay: {
    name: '中转站(OpenAI兼容)',
    defaultBaseUrl: '',
    currency: 'USD',
    async queryBalance(baseUrl, apiKey) {
      const headers = { Authorization: `Bearer ${apiKey}` };

      // 策略一：credit_grants 直接返回可用额度
      try {
        const res = await fetchWithTimeout(`${baseUrl}/v1/dashboard/billing/credit_grants`, { headers });
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

      // 策略二：subscription + usage 计算剩余额度
      try {
        const subRes = await fetchWithTimeout(`${baseUrl}/v1/dashboard/billing/subscription`, { headers });
        if (subRes.ok) {
          const sub = await tryJson(subRes);
          if (sub) {
            const hardLimit = parseFloat(sub.hard_limit ?? 0);
            const now = new Date();
            const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
            const end = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            const usageRes = await fetchWithTimeout(
              `${baseUrl}/v1/dashboard/billing/usage?start_date=${start}&end_date=${end}`,
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
      } catch { /* 继续抛错 */ }

      throw new Error('中转站不支持余额查询接口，请尝试「自定义」类型');
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
      const res = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await tryJson(res);
      if (!json) throw new Error('响应非 JSON');
      const val = getByPath(json, extra.customJsonPath);
      if (val == null) throw new Error(`JSON 路径 "${extra.customJsonPath}" 未找到值`);
      return {
        balance: parseFloat(val),
        currency: extra.customCurrency || '',
        raw: json,
      };
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

module.exports = { PROVIDERS, PROVIDER_LIST, getByPath };
