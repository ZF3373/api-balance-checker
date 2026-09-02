'use strict';

const http = require('http');
const crypto = require('crypto');
const store = require('./store');

let server = null;
let currentPort = null;

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
  const base = (keyEntry.baseUrl || '').replace(/\/$/, '');
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

// ─── 单次上游转发 ───

async function tryUpstream(keyEntry, method, path, reqBody, reqHeaders, { stream = false } = {}) {
  const url = getUpstreamUrl(keyEntry, path);
  const headers = buildUpstreamHeaders({ headers: reqHeaders }, keyEntry);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);

  try {
    const upstreamRes = await fetch(url, {
      method,
      headers,
      body: method !== 'GET' && method !== 'HEAD' ? reqBody : undefined,
      signal: controller.signal,
    });
    return upstreamRes;
  } finally {
    clearTimeout(timer);
  }
}

// ─── chat/completions 转发（带故障转移） ───

async function handleChatCompletions(req, res, body) {
  const keys = store.getAllKeys();
  if (keys.length === 0) {
    return sendJson(res, 503, { error: { message: '没有可用的 API Key，请先添加', type: 'server_error' } });
  }

  let lastError = null;

  for (const keyEntry of keys) {
    const base = (keyEntry.baseUrl || '');
    if (!base) continue;

    try {
      const upstreamRes = await tryUpstream(keyEntry, 'POST', 'v1/chat/completions', body, req.headers);

      // 成功 → 透传响应（支持流式）
      if (upstreamRes.ok) {
        relayResponse(res, upstreamRes);
        return;
      }

      // 401/403 → key 无效，跳过试下一个
      if (upstreamRes.status === 401 || upstreamRes.status === 403) {
        lastError = `${keyEntry.name}: 鉴权失败(${upstreamRes.status})`;
        continue;
      }

      // 429/5xx → 该 key 暂时不可用，跳过试下一个
      if (upstreamRes.status === 429 || upstreamRes.status >= 500) {
        const errText = await upstreamRes.text().catch(() => '');
        lastError = `${keyEntry.name}: 上游错误(${upstreamRes.status}) ${errText.slice(0, 200)}`;
        continue;
      }

      // 其他 4xx（400/404 等）→ 请求本身有问题，直接返回，不重试
      const errText = await upstreamRes.text().catch(() => '');
      relayRawResponse(res, upstreamRes.status, upstreamRes.headers, errText);
      return;
    } catch (err) {
      // 网络错误/超时 → 跳过试下一个
      const msg = err && err.name === 'AbortError' ? '请求超时' : (err.message || String(err));
      lastError = `${keyEntry.name}: ${msg}`;
      continue;
    }
  }

  // 全部失败
  sendJson(res, 502, {
    error: {
      message: `所有 API Key 均不可用。最后错误: ${lastError || '未知错误'}`,
      type: 'upstream_error',
    },
  });
}

// ─── embeddings 转发（带故障转移） ───

async function handleEmbeddings(req, res, body) {
  const keys = store.getAllKeys();
  if (keys.length === 0) {
    return sendJson(res, 503, { error: { message: '没有可用的 API Key', type: 'server_error' } });
  }

  let lastError = null;

  for (const keyEntry of keys) {
    const base = (keyEntry.baseUrl || '');
    if (!base) continue;

    try {
      const upstreamRes = await tryUpstream(keyEntry, 'POST', 'v1/embeddings', body, req.headers);

      if (upstreamRes.ok) {
        relayResponse(res, upstreamRes);
        return;
      }

      if (upstreamRes.status === 401 || upstreamRes.status === 403) {
        lastError = `${keyEntry.name}: 鉴权失败`;
        continue;
      }

      if (upstreamRes.status === 429 || upstreamRes.status >= 500) {
        lastError = `${keyEntry.name}: 上游错误(${upstreamRes.status})`;
        continue;
      }

      // 其他 4xx 直接返回
      const errText = await upstreamRes.text().catch(() => '');
      relayRawResponse(res, upstreamRes.status, upstreamRes.headers, errText);
      return;
    } catch (err) {
      const msg = err && err.name === 'AbortError' ? '请求超时' : (err.message || String(err));
      lastError = `${keyEntry.name}: ${msg}`;
      continue;
    }
  }

  sendJson(res, 502, {
    error: { message: `所有 API Key 均不可用。最后错误: ${lastError}`, type: 'upstream_error' },
  });
}

// ─── Anthropic Messages 转发（带故障转移） ───

async function handleMessages(req, res, body) {
  const keys = store.getAllKeys();
  if (keys.length === 0) {
    return sendJson(res, 503, { error: { message: '没有可用的 API Key，请先添加', type: 'server_error' } });
  }

  let lastError = null;

  for (const keyEntry of keys) {
    const base = (keyEntry.baseUrl || '');
    if (!base) continue;

    try {
      const upstreamRes = await tryUpstream(keyEntry, 'POST', 'v1/messages', body, req.headers);

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

      // 其他 4xx 直接返回
      const errText = await upstreamRes.text().catch(() => '');
      relayRawResponse(res, upstreamRes.status, upstreamRes.headers, errText);
      return;
    } catch (err) {
      const msg = err && err.name === 'AbortError' ? '请求超时' : (err.message || String(err));
      lastError = `${keyEntry.name}: ${msg}`;
      continue;
    }
  }

  sendJson(res, 502, {
    error: {
      type: 'upstream_error',
      message: `所有 API Key 均不可用。最后错误: ${lastError || '未知错误'}`,
    },
  });
}

// ─── models 聚合（并发查询所有上游，去重合并） ───

async function handleModels(req, res) {
  const keys = store.getAllKeys();
  if (keys.length === 0) {
    return sendJson(res, 200, { object: 'list', data: [] });
  }

  const results = await Promise.allSettled(
    keys
      .filter((k) => k.baseUrl)
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
  const pathname = url.pathname;

  // 收集请求体
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const body = chunks.length > 0 ? Buffer.concat(chunks) : null;

    try {
      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        await handleChatCompletions(req, res, body);
      } else if (pathname === '/v1/messages' && req.method === 'POST') {
        await handleMessages(req, res, body);
      } else if (pathname === '/v1/embeddings' && req.method === 'POST') {
        await handleEmbeddings(req, res, body);
      } else if (pathname === '/v1/models' && req.method === 'GET') {
        await handleModels(req, res);
      } else {
        sendJson(res, 404, { error: { message: `未知路径: ${pathname}`, type: 'invalid_request_error' } });
      }
    } catch (err) {
      sendJson(res, 500, { error: { message: `服务器内部错误: ${err.message}`, type: 'server_error' } });
    }
  });

  req.on('error', () => {
    if (!res.headersSent) sendJson(res, 400, { error: { message: '请求错误', type: 'server_error' } });
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
};
