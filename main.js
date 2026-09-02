'use strict';

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const semver = require('semver');
const store = require('./store');
const { PROVIDERS, PROVIDER_LIST } = require('./providers');
const proxy = require('./proxy');
const log = require('electron-log');

let mainWindow = null;

log.transports.file.level = 'info';

// ─── GitHub 仓库配置 ───
const GH_OWNER = 'ZF3373';
const GH_REPO = 'api-balance-checker';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: 'KeyHub · API Key 聚合 & 余额查询',
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

app.setAppUserModelId('com.zf3373.keyhub');

app.whenReady().then(async () => {
  // 跳过证书验证，确保能正常访问 GitHub API 和下载安装包
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

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

let updateInfo = null; // { version, progress, downloaded, checking, error }
let downloadedInstallerPath = null;

function sendUpdateStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', updateInfo);
  }
}

/**
 * 通过 GitHub API 查询所有 release，按 published_at 时间找到最新的 nightly 版本。
 * 不能用 semver 比较 nightly 版本号（git SHA 部分无顺序），
 * 仅用 semver 判断是否比当前版本更高（major.minor.patch 部分）。
 */
async function fetchLatestNightly() {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases?per_page=30`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'keyhub-updater', Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
    const releases = await res.json();
    const currentVersion = app.getVersion();

    // 按 published_at 降序排列，取最新的 prerelease
    const candidates = releases
      .filter((r) => !r.draft && r.prerelease === true)
      .filter((r) => semver.valid((r.tag_name || '').replace(/^v/, '')))
      .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

    if (candidates.length === 0) return null;

    const latest = candidates[0];
    const tag = (latest.tag_name || '').replace(/^v/, '');

    // 仅当 major.minor.patch 高于当前版本时才视为可更新
    // （同一天多个 nightly，patch 相同时也提示更新，用 published_at 判断新旧）
    if (semver.gte(tag, currentVersion) && tag !== currentVersion) {
      return { tag, release: latest };
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 直接从 GitHub Release 下载安装包，带进度回调。
 */
function downloadInstaller(assetUrl, totalSize) {
  return new Promise(async (resolve, reject) => {
    const tmpDir = os.tmpdir();
    const fileName = `keyhub-update-${Date.now()}.exe`;
    const filePath = path.join(tmpDir, fileName);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300000); // 5 分钟超时

    try {
      const res = await fetch(assetUrl, {
        headers: { 'User-Agent': 'keyhub-updater' },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);

      const contentLength = totalSize || parseInt(res.headers.get('content-length') || '0', 10);
      const fileStream = fs.createWriteStream(filePath);
      let received = 0;

      const reader = res.body.getReader();
      const pump = async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          fileStream.write(Buffer.from(value));
          received += value.length;
          if (contentLength > 0) {
            const pct = Math.round((received / contentLength) * 100);
            updateInfo = { ...updateInfo, progress: pct };
            sendUpdateStatus();
          }
        }
      };

      await pump();
      fileStream.end();
      fileStream.on('finish', () => {
        clearTimeout(timer);
        downloadedInstallerPath = filePath;
        resolve(filePath);
      });
      fileStream.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

ipcMain.handle('update:check', async () => {
  try {
    updateInfo = { ...updateInfo, checking: true, error: null };
    sendUpdateStatus();

    // 用 GitHub API 找到真正最新的 nightly 版本（不依赖 Atom feed 排序）
    const latest = await fetchLatestNightly();
    if (!latest) {
      updateInfo = { checking: false, notAvailable: true, error: null };
      sendUpdateStatus();
      return { ok: true };
    }

    // 找到安装包 asset
    const asset = latest.release.assets.find(
      (a) => a.name.endsWith('.exe') && !a.name.endsWith('.blockmap'),
    );
    if (!asset) {
      updateInfo = { checking: false, error: 'Release 中未找到安装包' };
      sendUpdateStatus();
      return { ok: false, error: '未找到安装包' };
    }

    // 通知 UI 发现新版本，开始下载
    updateInfo = { checking: false, version: latest.tag, progress: 0, downloaded: false, error: null };
    sendUpdateStatus();

    await downloadInstaller(asset.browser_download_url, asset.size);

    updateInfo = { ...updateInfo, checking: false, downloaded: true, progress: 100 };
    sendUpdateStatus();
    return { ok: true };
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? '请求超时' : (String(err.message || err));
    updateInfo = { ...updateInfo, checking: false, error: msg };
    sendUpdateStatus();
    return { ok: false, error: msg };
  }
});

ipcMain.handle('update:install', () => {
  if (!downloadedInstallerPath) return { ok: false, error: '安装包未下载' };
  // 启动安装包（NSIS installer 会自动关闭旧进程并覆盖安装）
  const child = spawn(downloadedInstallerPath, ['--force-run'], { detached: true, stdio: 'ignore' });
  child.unref();
  app.quit();
  return { ok: true };
});

ipcMain.handle('update:getVersion', () => app.getVersion());
