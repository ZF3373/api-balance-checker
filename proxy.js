'use strict';

const http = require('http');
const crypto = require('crypto');
const store = require('./store');
const { PROVIDERS, resolveBaseUrl, toErrorMessage, fetchWithTimeout } = require('./providers');

let server = null;
let currentPort = null;

// ─── 模型路由表 ───
// modelId -> [keyEntry, ...] 按插入顺序，代理启动时自动从各 Key 拉取 /v1/models 构建
let modelRouteMap = new Map();
let routeMapReady = false;
let routeMapBuilding = false;
let routeMapKeyCount = 0; // 构建时的 key 数量，用于检测变化后自动重建

// ─── 鉴权 ───

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function extractToken(req) {
  const auth = req.headers['authorization'];
  if (auth && /^bearer\s+/i.test(auth)) {
    return auth.replace(/^bearer\s+/i, '').trim();
  }
  const xKey = req.headers['x-api-key'];
  if (xKey) return Array.isArray(xKey) ? xKey[0].trim() : xKey.trim();
  return undefined;
}

function authenticate(req) {
  const token = extractToken(req);
  if (!token) return false;
  const unified = store.getUnifiedKey();
  if (!unified) return false;
  return timingSafeEqual(token, unified);
}

// ─── 工具函数 ───

function getUpstreamUrl(keyEntry, path) {
  const base = resolveBaseUrl(keyEntry).replace(/\/$/, '');
  const cleanPath = path.replace(/^\//, '');
  return `${base}/${cleanPath}`;
}

function buildUpstreamHeaders(req, keyEntry) {
  // 转发请求头，但替换鉴权为上游 key
  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['authorization'];
  delete headers['x-api-key'];
  headers['authorization'] = `Bearer ${keyEntry.apiKey}`;
  // 保留 Anthropic 协议特有的 anthropic-version 头
  return headers;
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

// ─── 模型路由表构建 ───

/**
 * 并发拉取所有 Key 的 /v1/models，构建 modelId -> [keyEntry, ...] 路由表。
 * 单个 Key 失败不影响其他 Key。构建完成后设 routeMapReady = true。
 */
async function buildRouteMap() {
  if (routeMapBuilding) return;
  routeMapBuilding = true;

  const keys = store.getAllKeys();
  routeMapKeyCount = keys.length;
  const newMap = new Map();

  const tasks = keys
    .filter((k) => resolveBaseUrl(k))
    .map(async (k) => {
      try {
        const res = await tryUpstream(k, 'GET', 'v1/models', null, {});
        if (!res.ok) return;
        const json = await res.json();
        const models = (json.data || []).map((m) => m.id).filter(Boolean);
        for (const modelId of models) {
          if (!newMap.has(modelId)) newMap.set(modelId, []);
          newMap.get(modelId).push(k);
        }
      } catch {
        // 单个 Key 拉取失败，跳过
      }
    });

  await Promise.allSettled(tasks);
  modelRouteMap = newMap;
  routeMapReady = true;
  routeMapBuilding = false;
}

/**
 * 如果 Key 数量变化（新增/删除/去重），触发路由表重建。
 * 在请求处理时惰性检测。
 */
function ensureRouteMapFresh() {
  if (!routeMapReady || routeMapBuilding) return;
  const currentCount = store.getAllKeys().length;
  if (currentCount !== routeMapKeyCount) {
    buildRouteMap();
  }
}

/**
 * 根据请求 body 中的 model 字段，返回候选 Key 列表。
 * 路由表中有该模型 → 返回支持它的 Key（精准路由）；
 * 路由表未就绪或模型不在表中 → 返回全部 Key（fallback 顺序故障转移）。
 * 用户在 UI 中为模型指定的优先 Key 会被排到候选列表最前。
 */
function getCandidateKeys(reqBody) {
  const allKeys = store.getAllKeys();
  ensureRouteMapFresh();

  let model = null;
  try {
    let parsed;
    if (typeof reqBody === 'string') {
      parsed = JSON.parse(reqBody);
    } else if (Buffer.isBuffer(reqBody)) {
      parsed = JSON.parse(reqBody.toString('utf8'));
    } else {
      parsed = reqBody;
    }
    model = parsed && parsed.model;
  } catch {
    // body 不是 JSON，fallback 到全部 Key
  }

  let candidates;
  if (model && routeMapReady && modelRouteMap.has(model)) {
    candidates = [...modelRouteMap.get(model)];
  } else {
    candidates = [...allKeys];
  }

  // 用户指定的优先 Key 排到最前
  if (model) {
    const routes = store.getModelRoutes();
    const preferredKeyId = routes[model];
    if (preferredKeyId) {
      const idx = candidates.findIndex((k) => k.id === preferredKeyId);
      if (idx > 0) {
        const [preferred] = candidates.splice(idx, 1);
        candidates.unshift(preferred);
      } else if (idx === -1) {
        // 优先 Key 不在候选列表中（可能路由表未含此模型），但从全部 Key 中找到则加入最前
        const preferredKey = allKeys.find((k) => k.id === preferredKeyId);
        if (preferredKey) candidates.unshift(preferredKey);
      }
    }
  }

  return candidates;
}

/**
 * 供外部调用的路由表刷新（如添加/删除 Key 后）。
 */
function refreshRouteMap() {
  routeMapReady = false;
  return buildRouteMap();
}

// ─── 单次上游转发 ───

async function tryUpstream(keyEntry, method, path, reqBody, reqHeaders) {
  const url = getUpstreamUrl(keyEntry, path);
  const headers = buildUpstreamHeaders({ headers: reqHeaders }, keyEntry);
  return fetchWithTimeout(url, {
    method,
    headers,
    body: method !== 'GET' && method !== 'HEAD' ? reqBody : undefined,
  }, 60000);
}

// ─── 统一故障转移转发 ───

async function forwardWithFailover({ keyEntries, method, upstreamPath, body, reqHeaders, res, errorType = 'server_error' }) {
  if (!keyEntries || keyEntries.length === 0) {
    return sendJson(res, 503, { error: { message: '没有可用的 API Key，请先添加', type: 'server_error' } });
  }

  let lastError = null;

  for (const keyEntry of keyEntries) {
    const base = resolveBaseUrl(keyEntry);
    if (!base) continue;

    try {
      const upstreamRes = await tryUpstream(keyEntry, method, upstreamPath, body, reqHeaders);

      if (upstreamRes.ok) {
        relayResponse(res, upstreamRes);
        return;
      }

      if (upstreamRes.status === 401 || upstreamRes.status === 403) {
        lastError = `${keyEntry.name}: 鉴权失败(${upstreamRes.status})`;
        continue;
      }

      if (upstreamRes.status === 429 || upstreamRes.status >= 500) {
        const errText = await upstreamRes.text().catch(() => '');
        lastError = `${keyEntry.name}: 上游错误(${upstreamRes.status}) ${errText.slice(0, 200)}`;
        continue;
      }

      // 其他 4xx —— 多平台聚合时可能是该上游不支持此模型，跳过试下一个
      const errText = await upstreamRes.text().catch(() => '');
      lastError = `${keyEntry.name}: HTTP ${upstreamRes.status} ${errText.slice(0, 200)}`;
      continue;
    } catch (err) {
      lastError = `${keyEntry.name}: ${toErrorMessage(err)}`;
      continue;
    }
  }

  sendJson(res, 502, {
    error: {
      message: `所有 API Key 均不可用。最后错误: ${lastError || '未知错误'}`,
      type: errorType,
    },
  });
}

// ─── models 聚合（路由表就绪时走缓存，否则实时查询） ───

async function handleModels(req, res) {
  ensureRouteMapFresh();

  // 路由表就绪 → 直接从内存返回去重模型列表（零上游请求）
  if (routeMapReady) {
    const data = [...modelRouteMap.keys()].sort().map((id) => ({ id, object: 'model' }));
    return sendJson(res, 200, { object: 'list', data });
  }

  // 路由表未就绪 → 实时并发查询所有上游（fallback）
  const keys = store.getAllKeys();
  if (keys.length === 0) {
    return sendJson(res, 200, { object: 'list', data: [] });
  }

  const results = await Promise.allSettled(
    keys
      .filter((k) => resolveBaseUrl(k))
      .map(async (k) => {
        const upstreamRes = await tryUpstream(k, 'GET', 'v1/models', null, req.headers);
        if (!upstreamRes.ok) throw new Error(`${k.name}: ${upstreamRes.status}`);
        const json = await upstreamRes.json();
        return (json.data || []).map((m) => ({ ...m, _source: k.name }));
      }),
  );

  // 合并去重
  const seen = new Set();
  const merged = [];
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    for (const model of r.value) {
      const id = model.id;
      if (id && !seen.has(id)) {
        seen.add(id);
        delete model._source;
        merged.push(model);
      }
    }
  }

  sendJson(res, 200, { object: 'list', data: merged });
}

// ─── 单个模型查询 ───

function handleModelDetail(req, res, modelId) {
  ensureRouteMapFresh();
  if (routeMapReady && modelRouteMap.has(modelId)) {
    return sendJson(res, 200, { id: modelId, object: 'model', owned_by: 'keyhub' });
  }
  sendJson(res, 404, { error: { message: `模型不存在: ${modelId}`, type: 'invalid_request_error' } });
}

// ─── 通用转发（带故障转移，供 images/audio/moderations/count_tokens 等复用） ───

async function handleForward(method, upstreamPath, reqBody, reqHeaders, res) {
  await forwardWithFailover({
    keyEntries: getCandidateKeys(reqBody),
    method,
    upstreamPath,
    body: reqBody,
    reqHeaders,
    res,
  });
}

// ─── 各端点薄封装 ───

async function handleChatCompletions(req, res, body) {
  await forwardWithFailover({
    keyEntries: getCandidateKeys(body),
    method: 'POST',
    upstreamPath: 'v1/chat/completions',
    body,
    reqHeaders: req.headers,
    res,
  });
}

async function handleEmbeddings(req, res, body) {
  await forwardWithFailover({
    keyEntries: getCandidateKeys(body),
    method: 'POST',
    upstreamPath: 'v1/embeddings',
    body,
    reqHeaders: req.headers,
    res,
  });
}

async function handleMessages(req, res, body) {
  await forwardWithFailover({
    keyEntries: getCandidateKeys(body),
    method: 'POST',
    upstreamPath: 'v1/messages',
    body,
    reqHeaders: req.headers,
    res,
  });
}

// ─── 响应透传 ───

function relayResponse(res, upstreamRes) {
  const headers = {};
  upstreamRes.headers.forEach((value, key) => {
    // 跳过 hop-by-hop 头
    const lower = key.toLowerCase();
    if (lower === 'transfer-encoding' || lower === 'content-encoding' || lower === 'connection') return;
    headers[key] = value;
  });

  // 流式响应（SSE）—— 逐块透传
  const contentType = upstreamRes.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') || contentType.includes('stream')) {
    res.writeHead(upstreamRes.status, headers);
    const reader = upstreamRes.body.getReader();
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch {
        // 客户端断开等，忽略
      }
      res.end();
    })();
    return;
  }

  // 非流式 —— 读取完整 body 后返回
  upstreamRes.arrayBuffer().then((buf) => {
    headers['content-length'] = Buffer.byteLength(buf);
    res.writeHead(upstreamRes.status, headers);
    res.end(Buffer.from(buf));
  }).catch(() => {
    sendJson(res, 502, { error: { message: '读取上游响应失败', type: 'upstream_error' } });
  });
}

function relayRawResponse(res, status, upstreamHeaders, bodyText) {
  const headers = {};
  upstreamHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'transfer-encoding' || lower === 'content-encoding' || lower === 'connection') return;
    headers[key] = value;
  });
  const buf = Buffer.from(bodyText);
  headers['content-length'] = buf.length;
  headers['content-type'] = headers['content-type'] || 'application/json';
  res.writeHead(status, headers);
  res.end(buf);
}

// ─── HTTP 请求处理 ───

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

function handleRequest(req, res) {
  // CORS 支持
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 鉴权
  if (!authenticate(req)) {
    return sendJson(res, 401, { error: { message: '无效的 API Key，请使用统一 Key', type: 'authentication_error' } });
  }

  const url = new URL(req.url, `http://127.0.0.1:${currentPort}`);
  // trailing slash 容错
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  // 收集请求体（带 size 限制）
  const chunks = [];
  let bodySize = 0;
  let tooLarge = false;

  req.on('data', (chunk) => {
    if (tooLarge) return;
    bodySize += chunk.length;
    if (bodySize > MAX_BODY_SIZE) {
      tooLarge = true;
      if (!res.headersSent) {
        sendJson(res, 413, { error: { message: '请求体过大（超过 10MB 限制）', type: 'invalid_request_error' } });
      }
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    if (tooLarge) return;

    const rawBody = chunks.length > 0 ? Buffer.concat(chunks) : null;

    // POST 端点：尝试解析 JSON 并验证必填字段
    let parsedBody = null;
    if (rawBody && req.method === 'POST') {
      try {
        parsedBody = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return sendJson(res, 400, { error: { message: '请求体不是有效的 JSON', type: 'invalid_request_error' } });
      }
    }

    // 验证必填字段
    if (parsedBody) {
      const requiresModel = ['/v1/chat/completions', '/v1/embeddings', '/v1/images/generations',
        '/v1/audio/speech', '/v1/moderations'].includes(pathname);
      if (requiresModel && !parsedBody.model) {
        return sendJson(res, 400, { error: { message: '缺少必填字段: model', type: 'invalid_request_error', param: 'model' } });
      }
      if (pathname === '/v1/chat/completions' && !parsedBody.messages) {
        return sendJson(res, 400, { error: { message: '缺少必填字段: messages', type: 'invalid_request_error', param: 'messages' } });
      }
      if (pathname === '/v1/messages' && !parsedBody.messages) {
        return sendJson(res, 400, { error: { message: '缺少必填字段: messages', type: 'invalid_request_error', param: 'messages' } });
      }
      if (pathname === '/v1/embeddings' && !parsedBody.input) {
        return sendJson(res, 400, { error: { message: '缺少必填字段: input', type: 'invalid_request_error', param: 'input' } });
      }
    }

    try {
      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        await handleChatCompletions(req, res, rawBody);
      } else if (pathname === '/v1/messages' && req.method === 'POST') {
        await handleMessages(req, res, rawBody);
      } else if (pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
        await handleForward('POST', 'v1/messages/count_tokens', rawBody, req.headers, res);
      } else if (pathname === '/v1/embeddings' && req.method === 'POST') {
        await handleEmbeddings(req, res, rawBody);
      } else if (pathname === '/v1/models' && req.method === 'GET') {
        await handleModels(req, res);
      } else if (pathname.startsWith('/v1/models/') && req.method === 'GET') {
        handleModelDetail(req, res, pathname.replace('/v1/models/', ''));
      } else if (pathname === '/v1/images/generations' && req.method === 'POST') {
        await handleForward('POST', 'v1/images/generations', rawBody, req.headers, res);
      } else if (pathname === '/v1/audio/speech' && req.method === 'POST') {
        await handleForward('POST', 'v1/audio/speech', rawBody, req.headers, res);
      } else if (pathname === '/v1/audio/transcriptions' && req.method === 'POST') {
        await handleForward('POST', 'v1/audio/transcriptions', rawBody, req.headers, res);
      } else if (pathname === '/v1/moderations' && req.method === 'POST') {
        await handleForward('POST', 'v1/moderations', rawBody, req.headers, res);
      } else if ((pathname === '/' || pathname === '/health') && req.method === 'GET') {
        sendJson(res, 200, { status: 'ok', service: 'KeyHub Proxy' });
      } else {
        sendJson(res, 404, { error: { message: `未知路径: ${pathname}`, type: 'invalid_request_error' } });
      }
    } catch (err) {
      sendJson(res, 500, { error: { message: `服务器内部错误: ${err.message}`, type: 'server_error' } });
    }
  });

  req.on('error', () => {
    if (!res.headersSent) sendJson(res, 400, { error: { message: '请求错误', type: 'invalid_request_error' } });
  });
}

// ─── 服务器生命周期 ───

function startServer(port) {
  return new Promise((resolve, reject) => {
    if (server) {
      return resolve({ ok: true, port: currentPort, message: '已在运行' });
    }
    server = http.createServer(handleRequest);
    server.on('error', (err) => {
      server = null;
      currentPort = null;
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      currentPort = port;
      // 异步构建模型路由表，不阻塞端口监听
      buildRouteMap();
      resolve({ ok: true, port });
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) {
      currentPort = null;
      return resolve({ ok: true });
    }
    server.close(() => {
      server = null;
      currentPort = null;
      modelRouteMap = new Map();
      routeMapReady = false;
      routeMapKeyCount = 0;
      resolve({ ok: true });
    });
    // 强制销毁残留连接
    server.closeAllConnections && server.closeAllConnections();
  });
}

function getServerStatus() {
  return {
    running: !!server,
    port: currentPort,
    endpoint: currentPort ? `http://127.0.0.1:${currentPort}/v1` : null,
  };
}

module.exports = {
  startServer,
  stopServer,
  getServerStatus,
  refreshRouteMap,
};
