'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let dataDir = '';
let storePath = '';

/**
 * 初始化存储路径（由主进程在 app.ready 后调用）
 */
function init(userDataDir) {
  dataDir = userDataDir;
  storePath = path.join(dataDir, 'keys.json');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(storePath)) {
    save({ keys: [], settings: {} });
  }
  // 确保有 unifiedKey
  const data = load();
  if (!data.settings) data.settings = {};
  if (!data.settings.unifiedKey) {
    data.settings.unifiedKey = 'sk-' + crypto.randomBytes(16).toString('hex');
    save(data);
  }
  if (!data.settings.proxyPort) {
    data.settings.proxyPort = 9527;
    save(data);
  }
}

function load() {
  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.keys)) data.keys = [];
    if (!data.settings || typeof data.settings !== 'object') data.settings = {};
    return data;
  } catch {
    return { keys: [], settings: {} };
  }
}

function save(data) {
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf-8');
}

function genId() {
  return crypto.randomUUID();
}

function getAllKeys() {
  return load().keys;
}

function getKey(id) {
  return load().keys.find((k) => k.id === id) || null;
}

function addKey(entry) {
  const data = load();
  const item = {
    id: genId(),
    name: entry.name || '未命名',
    provider: entry.provider,
    baseUrl: entry.baseUrl || '',
    apiKey: entry.apiKey || '',
    customBalancePath: entry.customBalancePath || '',
    customJsonPath: entry.customJsonPath || '',
    customCurrency: entry.customCurrency || '',
    // 查询结果缓存
    lastBalance: null,
    lastCurrency: null,
    lastQueryTime: null,
    lastError: null,
    lastStatus: null, // 'success' | 'error'
  };
  data.keys.push(item);
  save(data);
  return item;
}

function updateKey(id, patch) {
  const data = load();
  const item = data.keys.find((k) => k.id === id);
  if (!item) return null;
  Object.assign(item, patch);
  save(data);
  return item;
}

function deleteKey(id) {
  const data = load();
  data.keys = data.keys.filter((k) => k.id !== id);
  save(data);
  return true;
}

/**
 * 一键去重：按 apiKey 去除重复条目，保留每个 Key 的首次配置。
 * 与批量导入的去重口径一致（仅按 apiKey 判定）。
 * @returns {{ removed: number, total: number }}
 */
function dedupKeys() {
  const data = load();
  const seen = new Set();
  const before = data.keys.length;
  data.keys = data.keys.filter((k) => {
    if (seen.has(k.apiKey)) return false;
    seen.add(k.apiKey);
    return true;
  });
  const removed = before - data.keys.length;
  if (removed > 0) save(data);
  return { removed, total: data.keys.length };
}

/**
 * 批量新增 Key（同一平台多个 Key 一次性导入）。
 * 按 apiKey 去重：与已有 Key 重复的自动跳过，新增的连续编号命名。
 * 编号会接续同名前缀的最大编号，避免多次导入产生重名。
 * 一次读改存，避免逐条 IO。
 * @param {Array} entries  不含 name，由本函数按 namePrefix 编号
 * @param {string} namePrefix 名称前缀，编号后形如「前缀-1」
 * @returns {{ added: number, skipped: number }}
 */
function addKeys(entries, namePrefix) {
  const data = load();
  const existing = new Set(data.keys.map((k) => k.apiKey));

  // 找出已有同名前缀的最大编号，新导入从下一个编号开始
  const prefixPattern = new RegExp(
    '^' + String(namePrefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)$',
  );
  let idx = 0;
  for (const k of data.keys) {
    const m = (k.name || '').match(prefixPattern);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > idx) idx = n;
    }
  }

  let skipped = 0;
  const added = [];
  for (const entry of entries) {
    if (existing.has(entry.apiKey)) {
      skipped += 1;
      continue;
    }
    idx += 1;
    const item = {
      id: genId(),
      name: `${namePrefix}-${idx}`,
      provider: entry.provider,
      baseUrl: entry.baseUrl || '',
      apiKey: entry.apiKey,
      customBalancePath: entry.customBalancePath || '',
      customJsonPath: entry.customJsonPath || '',
      customCurrency: entry.customCurrency || '',
      lastBalance: null,
      lastCurrency: null,
      lastQueryTime: null,
      lastError: null,
      lastStatus: null,
    };
    data.keys.push(item);
    existing.add(entry.apiKey);
    added.push(item);
  }
  save(data);
  return { added: added.length, skipped };
}

function setQueryResult(id, result) {
  return updateKey(id, {
    lastBalance: result.balance,
    lastCurrency: result.currency,
    lastQueryTime: new Date().toISOString(),
    lastError: result.error || null,
    lastStatus: result.error ? 'error' : 'success',
  });
}

// ─── Settings ───

function getSettings() {
  return load().settings;
}

function saveSettings(patch) {
  const data = load();
  Object.assign(data.settings, patch);
  save(data);
  return data.settings;
}

function getUnifiedKey() {
  return load().settings.unifiedKey;
}

function regenerateUnifiedKey() {
  const newKey = 'sk-' + crypto.randomBytes(16).toString('hex');
  saveSettings({ unifiedKey: newKey });
  return newKey;
}

function getProxyPort() {
  return load().settings.proxyPort || 9527;
}

function setProxyPort(port) {
  saveSettings({ proxyPort: port });
  return port;
}

// ─── 模型路由优先级 ───
// settings.modelRoutes: { [modelId]: keyId }  用户为每个模型指定的优先 Key

function getModelRoutes() {
  return load().settings.modelRoutes || {};
}

function setModelRoute(modelId, keyId) {
  const data = load();
  if (!data.settings.modelRoutes) data.settings.modelRoutes = {};
  if (keyId) {
    data.settings.modelRoutes[modelId] = keyId;
  } else {
    delete data.settings.modelRoutes[modelId];
  }
  save(data);
  return data.settings.modelRoutes;
}

function clearModelRoutes() {
  const data = load();
  data.settings.modelRoutes = {};
  save(data);
  return {};
}

module.exports = {
  init,
  getAllKeys,
  getKey,
  addKey,
  addKeys,
  updateKey,
  deleteKey,
  dedupKeys,
  setQueryResult,
  getSettings,
  saveSettings,
  getUnifiedKey,
  regenerateUnifiedKey,
  getProxyPort,
  setProxyPort,
  getModelRoutes,
  setModelRoute,
  clearModelRoutes,
};
