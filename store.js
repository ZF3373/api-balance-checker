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

module.exports = {
  init,
  getAllKeys,
  getKey,
  addKey,
  updateKey,
  deleteKey,
  setQueryResult,
  getSettings,
  saveSettings,
  getUnifiedKey,
  regenerateUnifiedKey,
  getProxyPort,
  setProxyPort,
};
