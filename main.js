'use strict';

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const store = require('./store');
const { PROVIDERS, PROVIDER_LIST } = require('./providers');
const proxy = require('./proxy');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

let mainWindow = null;

// 自动更新日志
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
autoUpdater.autoDownload = true;
autoUpdater.allowPrerelease = true; // 收 nightly 预发布

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: 'API 余额查询',
    backgroundColor: '#0f1014',
    show: false,
    icon: path.join(__dirname, 'build', 'icon.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 消除启动白闪
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.setAppUserModelId('com.zf3373.api-balance-checker');

app.whenReady().then(async () => {
  // Chromium 网络栈在某些环境下因 SSL 证书链不完整导致 GitHub 请求 404，
  // 跳过证书验证确保 autoUpdater 能正常下载 latest.yml 和 exe
  session.defaultSession.setCertificateVerifyProc((_request, callback) => {
    callback(0);
  });

  // 清除渲染缓存，确保更新后加载最新 UI（而非缓存的旧 HTML/CSS/JS）
  await session.defaultSession.clearCache();
  await session.defaultSession.clearStorageData({
    storages: ['shadercache', 'serviceworkers', 'cachestorage'],
  });

  store.init(app.getPath('userData'));
  createWindow();

  // 启动后自动检查更新（仅打包环境生效）
  if (app.isPackaged) {
    autoUpdater.checkForUpdates();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  proxy.stopServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  proxy.stopServer();
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

// ────────────────────── 聚合代理服务器 ──────────────────────

ipcMain.handle('server:start', async (_e, port) => {
  const usePort = port || store.getProxyPort();
  try {
    await proxy.startServer(usePort);
    store.setProxyPort(usePort);
    return { ok: true, ...proxy.getServerStatus() };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('server:stop', async () => {
  await proxy.stopServer();
  return { ok: true, ...proxy.getServerStatus() };
});

ipcMain.handle('server:status', () => proxy.getServerStatus());

ipcMain.handle('server:getUnifiedKey', () => store.getUnifiedKey());

ipcMain.handle('server:regenerateKey', () => store.regenerateUnifiedKey());

ipcMain.handle('server:getPort', () => store.getProxyPort());

// ────────────────────── 自动更新 ──────────────────────

let updateInfo = null; // { version, progress, downloaded, checking, error }

function sendUpdateStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', updateInfo);
  }
}

ipcMain.handle('update:check', async () => {
  try {
    updateInfo = { ...updateInfo, checking: true, error: null };
    sendUpdateStatus();
    const result = await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    updateInfo = { ...updateInfo, checking: false, error: String(err) };
    sendUpdateStatus();
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('update:install', () => {
  autoUpdater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
  return { ok: true };
});

ipcMain.handle('update:getVersion', () => app.getVersion());

autoUpdater.on('checking-for-update', () => {
  updateInfo = { checking: true, error: null };
  sendUpdateStatus();
});

autoUpdater.on('update-available', (info) => {
  updateInfo = { checking: false, version: info.version, progress: 0, downloaded: false, error: null };
  sendUpdateStatus();
});

autoUpdater.on('update-not-available', () => {
  updateInfo = { checking: false, notAvailable: true, error: null };
  sendUpdateStatus();
});

autoUpdater.on('download-progress', (progress) => {
  updateInfo = { ...updateInfo, progress: Math.round(progress.percent), error: null };
  sendUpdateStatus();
});

autoUpdater.on('update-downloaded', (info) => {
  updateInfo = { ...updateInfo, checking: false, downloaded: true, version: info.version, progress: 100, error: null };
  sendUpdateStatus();
});

autoUpdater.on('error', (err) => {
  updateInfo = { ...updateInfo, checking: false, error: String(err) };
  sendUpdateStatus();
});
