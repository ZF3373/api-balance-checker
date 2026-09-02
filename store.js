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
    save({ keys: [] });
  }
}

function load() {
  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.keys)) data.keys = [];
    return data;
  } catch {
    return { keys: [] };
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

module.exports = {
  init,
  getAllKeys,
  getKey,
  addKey,
  updateKey,
  deleteKey,
  setQueryResult,
};
