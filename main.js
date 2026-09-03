'use strict';

const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('path');
const https = require('https');
const semver = require('semver');
const fs = require('fs');
const os = require('os');
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
    backgroundColor: '#131417',
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
ipcMain.handle('keys:add', async (_e, entry) => {
  const result = store.addKey(entry);
  proxy.refreshRouteMap();
  return result;
});

// 批量新增（同一平台多个 Key，自动去重 + 连续编号命名）
ipcMain.handle('keys:addBatch', async (_e, payload) => {
  const {
    provider,
    baseUrl,
    apiKeys,
    namePrefix,
    customBalancePath,
    customJsonPath,
    customCurrency,
  } = payload;
  const p = PROVIDERS[provider];
  // 前缀留空时回退到平台名，保证名称可读
  const prefix = (namePrefix && namePrefix.trim()) || (p ? p.name : provider);
  const entries = (apiKeys || []).map((key) => ({
    provider,
    baseUrl: baseUrl || '',
    apiKey: key,
    customBalancePath,
    customJsonPath,
    customCurrency,
  }));
  const result = store.addKeys(entries, prefix);
  proxy.refreshRouteMap();
  return result;
});

// 更新
ipcMain.handle('keys:update', (_e, id, patch) => store.updateKey(id, patch));

// 删除
ipcMain.handle('keys:delete', async (_e, id) => {
  const result = store.deleteKey(id);
  proxy.refreshRouteMap();
  return result;
});

// 一键去重（按 apiKey 去除重复，保留首次配置）
ipcMain.handle('keys:dedup', async () => {
  const result = store.dedupKeys();
  proxy.refreshRouteMap();
  return result;
});

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

// ─── 获取可用模型 + 连接测试 ───

/**
 * 规范化 baseUrl：去除尾部斜杠和多余的 /v1 后缀
 */
function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * 向上游 GET /v1/models 发起请求（不消耗 token）
 * 用 httpsGet 确保跳过证书验证（与 setCertificateVerifyProc 行为一致）
 */
async function fetchUpstreamModels(baseUrl, apiKey, timeoutMs = 15000) {
  const root = normalizeBaseUrl(baseUrl);
  const res = await httpsGet(`${root}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: timeoutMs,
  });
  return res;
}

// 获取可用模型列表
ipcMain.handle('keys:models', async (_e, id) => {
  const item = store.getKey(id);
  if (!item) return { error: 'Key 不存在' };

  const provider = PROVIDERS[item.provider];
  if (!provider) return { error: `未知提供商: ${item.provider}` };

  const baseUrl = item.baseUrl || provider.defaultBaseUrl;
  if (!baseUrl) return { error: '缺少 baseUrl' };

  try {
    const res = await fetchUpstreamModels(baseUrl, item.apiKey);
    if (res.statusCode !== 200) {
      const msg = `HTTP ${res.statusCode}`;
      res.resume();
      store.updateKey(id, { lastTestStatus: 'error', lastTestError: msg, lastTestTime: new Date().toISOString() });
      return { error: msg };
    }
    const json = await readJson(res);
    const models = (json.data || []).map((m) => m.id).filter(Boolean).sort();
    const now = new Date().toISOString();
    store.updateKey(id, {
      lastModels: models,
      lastModelsTime: now,
      lastTestStatus: 'ok',
      lastTestError: null,
      lastTestTime: now,
    });
    return { ok: true, models };
  } catch (err) {
    const msg = err.message || String(err);
    store.updateKey(id, { lastTestStatus: 'error', lastTestError: msg, lastTestTime: new Date().toISOString() });
    return { error: msg };
  }
});

// 连接测试：先验证连通性（GET /v1/models），再查余额。
// 余额 ≤ 0 视为"余额不足"，不当作连接正常。
ipcMain.handle('keys:test', async (_e, id) => {
  const item = store.getKey(id);
  if (!item) return { error: 'Key 不存在' };

  const provider = PROVIDERS[item.provider];
  if (!provider) return { error: `未知提供商: ${item.provider}` };

  const baseUrl = item.baseUrl || provider.defaultBaseUrl;
  if (!baseUrl) return { error: '缺少 baseUrl' };

  const now = new Date().toISOString();

  // 第一步：连通性测试
  let modelCount = 0;
  try {
    const res = await fetchUpstreamModels(baseUrl, item.apiKey, 10000);
    if (res.statusCode !== 200) {
      const msg = `HTTP ${res.statusCode}`;
      res.resume();
      store.updateKey(id, { lastTestStatus: 'error', lastTestError: msg, lastTestTime: now });
      return { ok: false, error: msg };
    }
    try {
      const json = await readJson(res);
      modelCount = (json.data || []).length;
    } catch { /* 非 JSON 也算连通正常 */ }
  } catch (err) {
    const msg = err.message || String(err);
    store.updateKey(id, { lastTestStatus: 'error', lastTestError: msg, lastTestTime: now });
    return { ok: false, error: msg };
  }

  // 第二步：余额检查（平台不支持时跳过，不影响连通性判定）
  let balance = null;
  let balanceError = null;
  try {
    const balanceResult = await provider.queryBalance(baseUrl, item.apiKey, {
      customBalancePath: item.customBalancePath,
      customJsonPath: item.customJsonPath,
      customCurrency: item.customCurrency,
    });
    balance = balanceResult.balance;
    // 顺便刷新余额缓存
    store.setQueryResult(id, balanceResult);
  } catch (err) {
    balanceError = err.message || String(err);
  }

  // 综合判定：连通 OK 但余额 ≤ 0 → 余额不足
  if (balance != null && balance <= 0) {
    store.updateKey(id, { lastTestStatus: 'insufficient', lastTestError: null, lastTestTime: now });
    return { ok: true, insufficient: true, modelCount, balance };
  }

  // 余额未知（不支持 / 查询失败）或余额 > 0 → 连接正常
  store.updateKey(id, { lastTestStatus: 'ok', lastTestError: null, lastTestTime: now });
  return { ok: true, modelCount, balance, balanceError };
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
let downloadedInstallerPath = null;

function sendUpdateStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', updateInfo);
  }
}

/**
 * 用 Node.js https 模块发起 GET 请求（自动跟随重定向，跳过证书验证）。
 * 不用 fetch，因为 Electron 主进程的 fetch 不受 setCertificateVerifyProc 影响，
 * 在证书链不完整的环境下会失败。
 */
function httpsGet(url, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('重定向次数过多'));
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error('请求超时'));
    }, options.timeout || 15000);

    const req = https.get(url, {
      headers: options.headers || {},
      rejectUnauthorized: false, // 跳过证书验证，与 setCertificateVerifyProc 保持一致
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timer);
        res.resume();
        httpsGet(res.headers.location, options, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      clearTimeout(timer);
      resolve(res);
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * 读取完整响应体并解析 JSON
 */
function readJson(res) {
  return new Promise((resolve, reject) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('响应非 JSON'));
      }
    });
    res.on('error', reject);
  });
}

/**
 * 通过 GitHub API 查询所有 release，按 published_at 时间找到最新的 nightly 版本。
 * 注意：不能用 semver 比较 nightly 版本号——git SHA 部分无顺序，
 * semver 会按字典序比较 SHA（如 'f3' > '4d'），导致误判。
 * 正确做法：用 published_at 时间戳判断哪个 release 最新，
 * 只要版本号不同且当前版本更早就提示更新。
 */
async function fetchLatestNightly() {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases?per_page=30`;
  const res = await httpsGet(url, {
    headers: { 'User-Agent': 'keyhub-updater', Accept: 'application/vnd.github+json' },
  });
  if (res.statusCode !== 200) throw new Error(`GitHub API HTTP ${res.statusCode}`);
  const releases = await readJson(res);
  const currentVersion = app.getVersion();

  // 按 published_at 降序排列，取最新的 prerelease
  const candidates = releases
    .filter((r) => !r.draft && r.prerelease === true)
    .filter((r) => semver.valid((r.tag_name || '').replace(/^v/, '')))
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

  if (candidates.length === 0) return null;

  const latest = candidates[0];
  const tag = (latest.tag_name || '').replace(/^v/, '');

  // 只要最新 release 的版本号与当前不同，就提示更新
  // （nightly 版本号含 git SHA，无法用 semver 比较先后，用 published_at 保证取到最新）
  if (tag !== currentVersion) {
    return { tag, release: latest };
  }
  return null;
}

/**
 * 用 Node.js https 模块下载安装包（自动跟随重定向，跳过证书验证），带进度回调。
 */
function downloadInstaller(assetUrl, totalSize) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const fileName = `keyhub-update-${Date.now()}.exe`;
    const filePath = path.join(tmpDir, fileName);
    const fileStream = fs.createWriteStream(filePath);
    let received = 0;
    let timer = null;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    };

    const done = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      downloadedInstallerPath = filePath;
      resolve(filePath);
    };

    const request = (url, redirectCount = 0) => {
      if (redirectCount > 5) {
        fail(new Error('重定向次数过多'));
        return;
      }

      timer = setTimeout(() => fail(new Error('下载超时')), 300000);

      const req = https.get(url, {
        headers: { 'User-Agent': 'keyhub-updater' },
        rejectUnauthorized: false,
      }, (res) => {
        // 跟随重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(timer);
          res.resume();
          request(res.headers.location, redirectCount + 1);
          return;
        }

        if (res.statusCode !== 200) {
          fail(new Error(`下载失败 HTTP ${res.statusCode}`));
          return;
        }

        const contentLength = totalSize || parseInt(res.headers['content-length'] || '0', 10);

        res.on('data', (chunk) => {
          fileStream.write(chunk);
          received += chunk.length;
          if (contentLength > 0) {
            const pct = Math.round((received / contentLength) * 100);
            updateInfo = { ...updateInfo, progress: pct };
            sendUpdateStatus();
          }
        });

        res.on('end', () => {
          fileStream.end();
        });

        fileStream.on('finish', done);
        fileStream.on('error', fail);
      });

      req.on('error', fail);
    };

    request(assetUrl);
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
  // 用 shell.openPath 启动 NSIS 安装包（会触发 UAC 提权），
  // 延迟退出让安装程序有时间启动
  const installerPath = downloadedInstallerPath;
  setTimeout(async () => {
    await shell.openPath(installerPath);
    app.quit();
  }, 500);
  return { ok: true };
});

ipcMain.handle('update:getVersion', () => app.getVersion());
