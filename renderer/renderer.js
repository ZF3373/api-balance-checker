'use strict';

// ─── 状态 ───
let providers = [];
let keys = [];
let editingId = null;
let queryingIds = new Set();
let busyIds = new Set();
let visibleKeyIds = new Set();
let proxyRunning = false;
let currentMode = 'single'; // 'single' | 'batch'

// ─── DOM ───
const $ = (id) => document.getElementById(id);
const keyList = $('key-list');
const emptyState = $('empty-state');
const modal = $('modal');
const form = $('key-form');
const providerSelect = $('f-provider');
const baseUrlInput = $('f-baseurl');
const baseUrlHint = $('f-baseurl-hint');
const customFields = $('custom-fields');
const modeTabs = $('mode-tabs');
const singleFields = $('single-fields');
const batchFields = $('batch-fields');
const apikeysTextarea = $('f-apikeys');
const batchCount = $('batch-count');

// ─── Toast 通知 ───
function showToast(msg, type = 'info', duration = 3000) {
  const container = $('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

// ─── 确认对话框 ───
function showConfirm(text, onConfirm) {
  const dialog = $('confirm-dialog');
  $('confirm-text').textContent = text;
  dialog.classList.remove('hidden');

  const ok = $('confirm-ok');
  const cancel = $('confirm-cancel');
  const backdrop = dialog.querySelector('.confirm-backdrop');

  const cleanup = () => {
    dialog.classList.add('hidden');
    ok.removeEventListener('click', okHandler);
    cancel.removeEventListener('click', cancelHandler);
    backdrop.removeEventListener('click', cancelHandler);
  };
  const okHandler = () => { cleanup(); onConfirm(); };
  const cancelHandler = () => cleanup();

  ok.addEventListener('click', okHandler);
  cancel.addEventListener('click', cancelHandler);
  backdrop.addEventListener('click', cancelHandler);
}

// ─── 初始化 ───
async function init() {
  providers = await window.api.providers.list();
  renderProviderOptions();
  await refreshKeys();
  await initProxy();
  await initUpdater();
  bindEvents();
}

// ─── 代理初始化 ───
async function initProxy() {
  const port = await window.api.server.getPort();
  $('proxy-port').value = port;
  const status = await window.api.server.status();
  proxyRunning = status.running;
  if (status.running) {
    const key = await window.api.server.getUnifiedKey();
    updateProxyUI(true, status.port, key);
  } else {
    updateProxyUI(false, port, null);
  }
}

function updateProxyUI(running, port, key) {
  proxyRunning = running;
  const dot = $('proxy-dot');
  const text = $('proxy-status-text');
  const toggle = $('proxy-toggle');
  const info = $('proxy-info');
  const portInput = $('proxy-port');

  if (running) {
    dot.className = 'status-dot running';
    text.textContent = `代理运行中 · 端口 ${port}`;
    toggle.textContent = '停止代理';
    toggle.classList.remove('btn-primary');
    toggle.classList.add('btn-danger');
    info.classList.remove('hidden');
    portInput.disabled = true;
    $('proxy-endpoint').textContent = `http://127.0.0.1:${port}/v1`;
    if (key) $('unified-key').value = key;
  } else {
    dot.className = 'status-dot stopped';
    text.textContent = '代理未启动';
    toggle.textContent = '启动代理';
    toggle.classList.add('btn-primary');
    toggle.classList.remove('btn-danger');
    info.classList.add('hidden');
    portInput.disabled = false;
  }
}

async function toggleProxy() {
  const toggle = $('proxy-toggle');
  toggle.disabled = true;
  if (proxyRunning) {
    await window.api.server.stop();
    updateProxyUI(false, null, null);
    showToast('代理已停止', 'info');
  } else {
    const port = parseInt($('proxy-port').value, 10) || 9527;
    const result = await window.api.server.start(port);
    if (!result.ok) {
      showToast('启动失败: ' + (result.error || '端口可能被占用'), 'error');
      updateProxyUI(false, port, null);
    } else {
      const key = await window.api.server.getUnifiedKey();
      updateProxyUI(true, result.port, key);
      showToast('代理已启动', 'success');
    }
  }
  toggle.disabled = false;
}

// ─── 自动更新 ───
async function initUpdater() {
  // 显示版本号
  const version = await window.api.updater.getVersion();
  $('app-version').textContent = `v${version}`;

  // 监听更新状态
  window.api.updater.onStatus((status) => {
    if (!status) return;
    handleUpdateStatus(status);
  });
}

function handleUpdateStatus(status) {
  const bar = $('update-bar');
  const versionEl = $('update-version');
  const actionBtn = $('update-action');
  const progressWrap = $('update-progress-wrap');
  const progressBar = $('update-progress-bar');
  const pctEl = $('update-pct');

  if (status.error) {
    bar.classList.remove('show');
    showToast('更新检查失败: ' + status.error, 'error');
    return;
  }

  if (status.checking) {
    const btn = $('check-update');
    btn.innerHTML = '<span class="spinner"></span>';
    btn.disabled = true;
    return;
  }

  // 恢复检查按钮
  const btn = $('check-update');
  btn.innerHTML = '🔄';
  btn.disabled = false;

  if (status.notAvailable) {
    showToast('已是最新版本', 'info');
    bar.classList.remove('show');
    return;
  }

  if (status.version) {
    bar.classList.add('show');
    versionEl.textContent = `v${status.version}`;

    if (status.downloaded) {
      progressWrap.style.display = 'none';
      pctEl.style.display = 'none';
      actionBtn.textContent = '重启安装';
      actionBtn.disabled = false;
      actionBtn.onclick = () => window.api.updater.install();
    } else if (status.progress != null) {
      progressWrap.style.display = 'block';
      pctEl.style.display = 'inline';
      progressBar.style.width = `${status.progress}%`;
      pctEl.textContent = `${status.progress}%`;
      actionBtn.textContent = '下载中...';
      actionBtn.disabled = true;
    } else {
      progressWrap.style.display = 'none';
      pctEl.style.display = 'none';
      actionBtn.textContent = '下载中...';
      actionBtn.disabled = true;
    }
  }
}

async function checkUpdate() {
  const btn = $('check-update');
  btn.innerHTML = '<span class="spinner"></span>';
  btn.disabled = true;
  const result = await window.api.updater.check();
  if (!result.ok) {
    btn.innerHTML = '🔄';
    btn.disabled = false;
    showToast('检查失败: ' + (result.error || ''), 'error');
  }
}

function renderProviderOptions() {
  providerSelect.innerHTML = providers
    .map((p) => `<option value="${p.key}">${p.name}</option>`)
    .join('');
}

// ─── 事件绑定 ───
function bindEvents() {
  $('add-key').addEventListener('click', () => openModal());
  $('empty-add').addEventListener('click', () => openModal());
  $('refresh-all').addEventListener('click', refreshAll);
  $('dedup-keys').addEventListener('click', dedupKeys);
  $('check-update').addEventListener('click', checkUpdate);

  $('modal-close').addEventListener('click', closeModal);
  $('modal-cancel').addEventListener('click', closeModal);
  modal.querySelector('.modal-backdrop').addEventListener('click', closeModal);

  // 模式切换
  modeTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.mode-tab');
    if (!tab) return;
    switchMode(tab.dataset.mode);
  });
  apikeysTextarea.addEventListener('input', updateBatchCount);

  providerSelect.addEventListener('change', onProviderChange);
  form.addEventListener('submit', onSave);

  // 代理事件
  $('proxy-toggle').addEventListener('click', toggleProxy);
  $('copy-key').addEventListener('click', copyUnifiedKey);
  $('regen-key').addEventListener('click', regenUnifiedKey);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!modal.classList.contains('hidden')) closeModal();
      if (!$('confirm-dialog').classList.contains('hidden')) {
        $('confirm-dialog').classList.add('hidden');
      }
    }
  });
}

async function copyUnifiedKey() {
  const key = $('unified-key').value;
  if (!key) return;
  try {
    await navigator.clipboard.writeText(key);
    showToast('统一 Key 已复制', 'success', 1500);
  } catch {
    $('unified-key').select();
    document.execCommand('copy');
    showToast('统一 Key 已复制', 'success', 1500);
  }
}

async function regenUnifiedKey() {
  showConfirm('重新生成统一 Key 后，旧的 Key 将失效，所有使用旧 Key 的客户端需要更新。确认？', async () => {
    const newKey = await window.api.server.regenerateKey();
    $('unified-key').value = newKey;
    showToast('统一 Key 已重新生成', 'success');
  });
}

function onProviderChange() {
  const p = providers.find((x) => x.key === providerSelect.value);
  if (!p) return;
  if (p.defaultBaseUrl) {
    baseUrlInput.placeholder = p.defaultBaseUrl;
    baseUrlHint.textContent = `留空则使用默认: ${p.defaultBaseUrl}`;
  } else {
    baseUrlInput.placeholder = 'https://...';
    baseUrlHint.textContent = '必填';
  }
  customFields.classList.toggle('hidden', p.key !== 'custom');
}

// ─── 批量导入辅助 ───

function switchMode(mode) {
  currentMode = mode;
  modeTabs.querySelectorAll('.mode-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
  singleFields.classList.toggle('hidden', mode !== 'single');
  batchFields.classList.toggle('hidden', mode !== 'batch');
  $('modal-save').textContent = mode === 'batch' ? '批量导入' : '保存';
}

/**
 * 解析批量输入：按换行/逗号/分号/空白分隔，去空、去重、trim
 */
function parseBatchKeys(raw) {
  const parts = (raw || '')
    .split(/[\n,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

function updateBatchCount() {
  const count = parseBatchKeys(apikeysTextarea.value).length;
  batchCount.textContent = count > 0 ? `检测到 ${count} 个有效 Key` : '';
}

// ─── 模态框 ───
function openModal(key = null) {
  editingId = key ? key.id : null;
  $('modal-title').textContent = key ? '编辑 API Key' : '添加 API Key';

  // 编辑模式仅支持单个，隐藏模式切换；新增时显示切换并默认单个
  modeTabs.classList.toggle('hidden', !!key);
  switchMode('single');

  $('f-name').value = key ? key.name : '';
  providerSelect.value = key ? key.provider : 'deepseek';
  baseUrlInput.value = key ? key.baseUrl : '';
  $('f-apikey').value = key ? key.apiKey : '';
  $('f-name-prefix').value = '';
  apikeysTextarea.value = '';
  updateBatchCount();
  $('f-custom-path').value = key ? key.customBalancePath || '' : '';
  $('f-custom-jsonpath').value = key ? key.customJsonPath || '' : '';
  $('f-custom-currency').value = key ? key.customCurrency || '' : '';

  onProviderChange();
  modal.classList.remove('hidden');
  setTimeout(() => $('f-name').focus(), 50);
}

function closeModal() {
  modal.classList.add('hidden');
  editingId = null;
  form.reset();
}

async function onSave(e) {
  e.preventDefault();
  const provider = providerSelect.value;
  const baseUrl = baseUrlInput.value.trim();
  const customBalancePath = $('f-custom-path').value.trim();
  const customJsonPath = $('f-custom-jsonpath').value.trim();
  const customCurrency = $('f-custom-currency').value.trim();

  // 批量导入
  if (currentMode === 'batch' && !editingId) {
    const apiKeys = parseBatchKeys(apikeysTextarea.value);
    if (apiKeys.length === 0) {
      showToast('请输入至少一个 API Key', 'error', 2000);
      return;
    }
    const namePrefix = $('f-name-prefix').value.trim();
    const result = await window.api.keys.addBatch({
      provider,
      baseUrl,
      apiKeys,
      namePrefix,
      customBalancePath,
      customJsonPath,
      customCurrency,
    });
    if (result.added > 0) {
      const msg = result.skipped > 0
        ? `已导入 ${result.added} 个，跳过 ${result.skipped} 个重复`
        : `已导入 ${result.added} 个 Key`;
      showToast(msg, 'success', 2500);
    } else {
      showToast(`全部 ${result.skipped} 个 Key 均已存在，已跳过`, 'info', 2500);
    }
    closeModal();
    await refreshKeys();
    return;
  }

  // 单个添加 / 编辑
  const entry = {
    name: $('f-name').value.trim(),
    provider,
    baseUrl,
    apiKey: $('f-apikey').value.trim(),
    customBalancePath,
    customJsonPath,
    customCurrency,
  };

  if (!entry.name || !entry.apiKey) return;

  if (editingId) {
    await window.api.keys.update(editingId, entry);
    showToast('已更新', 'success', 1500);
  } else {
    await window.api.keys.add(entry);
    showToast('已添加', 'success', 1500);
  }

  closeModal();
  await refreshKeys();
}

// ─── 列表渲染 ───
async function refreshKeys() {
  keys = await window.api.keys.list();
  renderList();
}

function renderList() {
  if (keys.length === 0) {
    emptyState.style.display = 'flex';
    keyList.style.display = 'none';
    return;
  }
  emptyState.style.display = 'none';
  keyList.style.display = 'flex';

  keyList.innerHTML = keys.map(renderCard).join('');

  keys.forEach((k) => {
    const card = document.querySelector(`[data-id="${k.id}"]`);
    if (!card) return;
    card.querySelector('.btn-query').addEventListener('click', () => queryOne(k.id));
    card.querySelector('.btn-models').addEventListener('click', () => fetchModels(k.id));
    card.querySelector('.btn-test').addEventListener('click', () => testConnection(k.id));
    card.querySelector('.btn-edit').addEventListener('click', () => {
      const item = keys.find((x) => x.id === k.id);
      openModal(item);
    });
    card.querySelector('.btn-del').addEventListener('click', () => deleteOne(k.id));
    // Key 显示/隐藏 + 复制
    const toggleBtn = card.querySelector('.btn-key-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        if (visibleKeyIds.has(k.id)) visibleKeyIds.delete(k.id);
        else visibleKeyIds.add(k.id);
        renderList();
      });
    }
    const copyBtn = card.querySelector('.btn-key-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(k.apiKey);
          showToast('Key 已复制', 'success', 1500);
        } catch {
          showToast('复制失败', 'error', 1500);
        }
      });
    }
  });
}

function renderCard(k) {
  const provider = providers.find((p) => p.key === k.provider);
  const providerName = provider ? provider.name : k.provider;
  const isQuerying = queryingIds.has(k.id);
  const isBusy = busyIds.has(k.id);

  let balanceHtml;
  let badgeHtml;
  if (isQuerying) {
    balanceHtml = `<span class="balance-value status-pending"><span class="spinner"></span> 查询中</span>`;
    badgeHtml = `<span class="badge badge-pending">查询中</span>`;
  } else if (k.lastStatus === 'success' && k.lastBalance != null) {
    const cur = k.lastCurrency || '';
    balanceHtml = `<span class="balance-value status-success">${formatBalance(k.lastBalance)}</span>
                   <span class="balance-currency">${cur}</span>`;
    badgeHtml = `<span class="badge badge-success">正常</span>`;
  } else if (k.lastStatus === 'error') {
    balanceHtml = `<span class="balance-value status-error" title="${escapeHtml(k.lastError || '')}">${escapeHtml(k.lastError || '查询失败')}</span>`;
    badgeHtml = `<span class="badge badge-error">异常</span>`;
  } else {
    balanceHtml = `<span class="balance-value status-pending">未查询</span>`;
    badgeHtml = `<span class="badge badge-pending">未查询</span>`;
  }

  const timeStr = k.lastQueryTime
    ? `更新于 ${formatTime(k.lastQueryTime)}`
    : '';

  const maskedKey = maskKey(k.apiKey);
  const isKeyVisible = visibleKeyIds.has(k.id);
  const displayKey = isKeyVisible ? k.apiKey : maskedKey;

  // 连接状态指示
  let testIndicator = '';
  if (k.lastTestStatus === 'ok') {
    testIndicator = ` · <span class="test-ok">连接正常</span>`;
  } else if (k.lastTestStatus === 'error') {
    testIndicator = ` · <span class="test-err" title="${escapeHtml(k.lastTestError || '')}">连接异常</span>`;
  }

  // 模型列表展开区
  let modelsHtml = '';
  if (k.lastModels && k.lastModels.length > 0) {
    const modelsTime = k.lastModelsTime ? ` · ${formatTime(k.lastModelsTime)}` : '';
    modelsHtml = `
      <div class="key-models">
        <span class="models-label">可用模型 (${k.lastModels.length})${modelsTime}</span>
        <div class="models-list">
          ${k.lastModels.map((m) => `<span class="model-chip">${escapeHtml(m)}</span>`).join('')}
        </div>
      </div>
    `;
  }

  return `
    <div class="key-card${modelsHtml ? ' has-models' : ''}" data-id="${k.id}">
      <div class="key-info">
        <div class="key-name">
          ${escapeHtml(k.name)}
          <span class="provider-tag">${escapeHtml(providerName)}</span>
          ${badgeHtml}
        </div>
        <div class="key-meta">
          <span class="key-text" title="${isKeyVisible ? '' : '点击眼睛查看完整 Key'}">${escapeHtml(displayKey)}</span>
          <button class="btn-key-toggle" data-id="${k.id}" title="${isKeyVisible ? '隐藏' : '显示'} Key">${isKeyVisible ? '🙈' : '👁'}</button>
          <button class="btn-key-copy" data-id="${k.id}" title="复制 Key">📋</button>
          ${k.baseUrl ? ' · ' + escapeHtml(k.baseUrl) : ''}${testIndicator}
        </div>
        <div class="key-balance">${balanceHtml}</div>
        ${timeStr ? `<div class="balance-time">${timeStr}</div>` : ''}
      </div>
      <div class="key-actions">
        <button class="btn btn-sm btn-primary btn-query" ${isQuerying || isBusy ? 'disabled' : ''} title="查询余额">查询</button>
        <button class="btn btn-sm btn-icon btn-models" ${isBusy ? 'disabled' : ''} title="获取可用模型">${isBusy ? '<span class="spinner"></span>' : '🤖'}</button>
        <button class="btn btn-sm btn-icon btn-test" ${isBusy ? 'disabled' : ''} title="测试连接">${isBusy ? '<span class="spinner"></span>' : '⚡'}</button>
        <button class="btn btn-sm btn-icon btn-edit" title="编辑">✎</button>
        <button class="btn btn-sm btn-icon btn-del" title="删除">🗑</button>
      </div>
      ${modelsHtml}
    </div>
  `;
}

// ─── 查询 ───
async function queryOne(id) {
  queryingIds.add(id);
  renderList();
  await window.api.keys.query(id);
  queryingIds.delete(id);
  await refreshKeys();
}

// ─── 获取可用模型 ───
async function fetchModels(id) {
  busyIds.add(id);
  renderList();
  const result = await window.api.keys.models(id);
  busyIds.delete(id);
  await refreshKeys();
  if (result.error) {
    showToast('获取模型失败: ' + result.error, 'error');
  } else {
    showToast(`获取到 ${result.models.length} 个模型`, 'success', 1500);
  }
}

// ─── 连接测试 ───
async function testConnection(id) {
  busyIds.add(id);
  renderList();
  const result = await window.api.keys.test(id);
  busyIds.delete(id);
  await refreshKeys();
  if (result.ok) {
    showToast('连接正常' + (result.modelCount ? ` · ${result.modelCount} 个模型` : ''), 'success', 1500);
  } else {
    showToast('连接异常: ' + (result.error || '未知错误'), 'error');
  }
}

async function refreshAll() {
  if (keys.length === 0) return;
  keys.forEach((k) => queryingIds.add(k.id));
  renderList();
  const btn = $('refresh-all');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 刷新中';
  try {
    await window.api.keys.queryAll();
  } finally {
    keys.forEach((k) => queryingIds.delete(k.id));
    btn.disabled = false;
    btn.innerHTML = '↻ 刷新全部';
    await refreshKeys();
  }
}

// ─── 一键去重 ───
async function dedupKeys() {
  if (keys.length === 0) {
    showToast('没有可去重的 Key', 'info', 1500);
    return;
  }
  showConfirm('将扫描并删除重复的 API Key（保留每个 Key 的首次配置），确认？', async () => {
    const result = await window.api.keys.dedup();
    await refreshKeys();
    if (result.removed > 0) {
      showToast(`已删除 ${result.removed} 个重复 Key`, 'success', 2500);
    } else {
      showToast('未发现重复 Key', 'info', 2000);
    }
  });
}

// ─── 删除 ───
async function deleteOne(id) {
  const item = keys.find((k) => k.id === id);
  if (!item) return;
  showConfirm(`确认删除「${item.name}」？`, async () => {
    await window.api.keys.remove(id);
    await refreshKeys();
    showToast('已删除', 'info', 1500);
  });
}

// ─── 工具函数 ───
function formatBalance(n) {
  if (n == null || isNaN(n)) return '--';
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return key.slice(0, 2) + '****';
  return key.slice(0, 6) + '****' + key.slice(-4);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── 启动 ───
init();
