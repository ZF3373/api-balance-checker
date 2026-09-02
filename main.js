'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const store = require('./store');
const { PROVIDERS, PROVIDER_LIST } = require('./providers');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: 'API 余额查询',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  store.init(app.getPath('userData'));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ────────────────────── IPC 处理 ──────────────────────

// 返回可用提供商列表
ipcMain.handle('providers:list', () => PROVIDER_LIST);

// 返回所有 Key 配置（API Key 本身可返回，本地自用工具）
ipcMain.handle('keys:list', () => store.getAllKeys());

// 新增
ipcMain.handle('keys:add', (_e, entry) => store.addKey(entry));

// 更新
ipcMain.handle('keys:update', (_e, id, patch) => store.updateKey(id, patch));

// 删除
ipcMain.handle('keys:delete', (_e, id) => store.deleteKey(id));

// 查询单个 Key 余额
ipcMain.handle('keys:query', async (_e, id) => {
  const item = store.getKey(id);
  if (!item) return { error: 'Key 不存在' };

  const provider = PROVIDERS[item.provider];
  if (!provider) return { error: `未知提供商: ${item.provider}` };

  const baseUrl = item.baseUrl || provider.defaultBaseUrl;
  if (!baseUrl && item.provider !== 'custom') {
    const err = `缺少 baseUrl，且 ${provider.name} 无默认值`;
    store.setQueryResult(item.id, { error: err, balance: null, currency: null });
    return { error: err };
  }

  try {
    const result = await provider.queryBalance(baseUrl, item.apiKey, {
      customBalancePath: item.customBalancePath,
      customJsonPath: item.customJsonPath,
      customCurrency: item.customCurrency,
    });
    store.setQueryResult(item.id, result);
    return { ok: true, result };
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? '请求超时' : (err.message || String(err));
    store.setQueryResult(item.id, { error: msg, balance: null, currency: null });
    return { error: msg };
  }
});

// 查询全部 Key 余额（并发）
ipcMain.handle('keys:queryAll', async () => {
  const keys = store.getAllKeys();
  await Promise.all(
    keys.map(async (k) => {
      const item = store.getKey(k.id);
      if (!item) return;
      const provider = PROVIDERS[item.provider];
      if (!provider) {
        store.setQueryResult(item.id, { error: '未知提供商', balance: null, currency: null });
        return;
      }
      const baseUrl = item.baseUrl || provider.defaultBaseUrl;
      if (!baseUrl && item.provider !== 'custom') {
        store.setQueryResult(item.id, { error: `缺少 baseUrl`, balance: null, currency: null });
        return;
      }
      try {
        const result = await provider.queryBalance(baseUrl, item.apiKey, {
          customBalancePath: item.customBalancePath,
          customJsonPath: item.customJsonPath,
          customCurrency: item.customCurrency,
        });
        store.setQueryResult(item.id, result);
      } catch (err) {
        const msg = err && err.name === 'AbortError' ? '请求超时' : (err.message || String(err));
        store.setQueryResult(item.id, { error: msg, balance: null, currency: null });
      }
    }),
  );
  return store.getAllKeys();
});
