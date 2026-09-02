'use strict';

// ─── 状态 ───
let providers = [];
let keys = [];
let editingId = null;
let queryingIds = new Set();

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

// ─── 初始化 ───
async function init() {
  providers = await window.api.providers.list();
  renderProviderOptions();
  await refreshKeys();
  bindEvents();
}

function renderProviderOptions() {
  providerSelect.innerHTML = providers
    .map(
      (p) =>
        `<option value="${p.key}">${p.name}${p.defaultBaseUrl ? '' : ''}</option>`,
    )
    .join('');
}

// ─── 事件绑定 ───
function bindEvents() {
  $('add-key').addEventListener('click', () => openModal());
  $('empty-add').addEventListener('click', () => openModal());
  $('refresh-all').addEventListener('click', refreshAll);

  $('modal-close').addEventListener('click', closeModal);
  $('modal-cancel').addEventListener('click', closeModal);
  modal.querySelector('.modal-backdrop').addEventListener('click', closeModal);

  providerSelect.addEventListener('change', onProviderChange);
  form.addEventListener('submit', onSave);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
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
    baseUrlHint.textContent = p.key === 'custom' ? '必填' : '必填';
  }
  customFields.classList.toggle('hidden', p.key !== 'custom');
}

// ─── 模态框 ───
function openModal(key = null) {
  editingId = key ? key.id : null;
  $('modal-title').textContent = key ? '编辑 API Key' : '添加 API Key';

  $('f-name').value = key ? key.name : '';
  providerSelect.value = key ? key.provider : 'deepseek';
  baseUrlInput.value = key ? key.baseUrl : '';
  $('f-apikey').value = key ? key.apiKey : '';
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
  const entry = {
    name: $('f-name').value.trim(),
    provider: providerSelect.value,
    baseUrl: baseUrlInput.value.trim(),
    apiKey: $('f-apikey').value.trim(),
    customBalancePath: $('f-custom-path').value.trim(),
    customJsonPath: $('f-custom-jsonpath').value.trim(),
    customCurrency: $('f-custom-currency').value.trim(),
  };

  if (!entry.name || !entry.apiKey) return;

  if (editingId) {
    await window.api.keys.update(editingId, entry);
  } else {
    await window.api.keys.add(entry);
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

  // 绑定按钮事件
  keys.forEach((k) => {
    const card = document.querySelector(`[data-id="${k.id}"]`);
    if (!card) return;
    card.querySelector('.btn-query').addEventListener('click', () => queryOne(k.id));
    card.querySelector('.btn-edit').addEventListener('click', () => {
      const item = keys.find((x) => x.id === k.id);
      openModal(item);
    });
    card.querySelector('.btn-del').addEventListener('click', () => deleteOne(k.id));
  });
}

function renderCard(k) {
  const provider = providers.find((p) => p.key === k.provider);
  const providerName = provider ? provider.name : k.provider;
  const isQuerying = queryingIds.has(k.id);

  // 余额显示
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

  return `
    <div class="key-card" data-id="${k.id}">
      <div class="key-info">
        <div class="key-name">
          ${escapeHtml(k.name)}
          <span class="provider-tag">${escapeHtml(providerName)}</span>
          ${badgeHtml}
        </div>
        <div class="key-meta">${escapeHtml(maskedKey)}${k.baseUrl ? ' · ' + escapeHtml(k.baseUrl) : ''}</div>
        <div class="key-balance">${balanceHtml}</div>
        ${timeStr ? `<div class="balance-time">${timeStr}</div>` : ''}
      </div>
      <div class="key-actions">
        <button class="btn btn-sm btn-primary btn-query" ${isQuerying ? 'disabled' : ''}>查询</button>
        <button class="btn btn-sm btn-edit">编辑</button>
        <button class="btn btn-sm btn-del">删除</button>
      </div>
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

// ─── 删除 ───
async function deleteOne(id) {
  const item = keys.find((k) => k.id === id);
  if (!item) return;
  if (!confirm(`确认删除「${item.name}」？`)) return;
  await window.api.keys.remove(id);
  await refreshKeys();
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
