# Electron 去重审计报告 — KeyHub
<!--
本报告由只读审计 Preset 生成，未修改任何业务源码。
报告文件：api-balance-checker/DEDUP-AUDIT-REPORT.md
-->

## 摘要

- **工作区**：`C:\Users\33739\Desktop\KeyHub\api-balance-checker`
- **扫描范围（分层）**：
  - `main`: `main.js`
  - `preload`: `preload.js`
  - `renderer`: `renderer/renderer.js`（+ `index.html`、`styles.css`）
  - `main 共享模块`: `providers.js` / `proxy.js` / `store.js`
- **排除目录**：`node_modules`、`dist`、`build`、`package-lock.json`、启动脚本
- **文件约数**：源码 6 个（JS）＋ 2 个 HTML/CSS
- **发现簇数**：high **2** / med **4** / low **2**

## Top 问题

- **H1** · 故障转移转发逻辑在 `proxy.js` 内重复 4 次（chat / embeddings / messages / forward）
- **H2** · `normalizeBaseUrl` 在 `main.js` 与 `providers.js` 完全重复（跨文件近似复制）
- **M1** · baseUrl 解析逻辑 `item.baseUrl || provider.defaultBaseUrl` 在 `main.js` 四处手写，与 `proxy.js` 的 `resolveBaseUrl` 同源
- **M2** · `AbortError → 请求超时` 错误映射在 `main.js` 与 `proxy.js` 共出现 7 处
- **M3** · IPC 通道字符串在 `main.js` 与 `preload.js` 手写对应，无共享通道映射
- **M4** · fetch 超时封装重复：`providers.js:fetchWithTimeout` 与 `proxy.js:tryUpstream` 同构
- **L1** · 跳转跟随 / 跳过证书逻辑在 `main.js` 的 `httpsGet` 与 `downloadInstaller` 内近似重复
- **L2** · `providers.js` 中多个 provider 的 `queryBalance` 骨架高度同构

---

## 重复簇明细

### H1 · nearDuplicate · proxy.js 内四个故障转移转发循环几乎一致

- **位置**：`proxy.js` — `handleChatCompletions`(L215) / `handleEmbeddings`(L273) / `handleMessages`(L321) / `handleForward`(L429)
- **分层**：main（主要）
- **证据**：四个函数共享完全一样的骨架——取候选 key → 空则 503 → 遍历 key 循环 → `tryUpstream` → `ok` 则透传返回 → `401/403` 跳过 → `429/5xx` 跳过 → 其它 4xx 跳过 → catch（超时/网络）跳过 → 全部失败返回 502。其中 `handleChatCompletions`、`handleEmbeddings`、`handleMessages` 之间的差异**仅在于 url 路径和 `handleEmbeddings` 少了一段 errText**：
  ```js
  // handleChatCompletions / handleMessages 几乎相同
  if (upstreamRes.status === 401 || upstreamRes.status === 403) {
    lastError = `${keyEntry.name}: 鉴权失败(${upstreamRes.status})`;
    continue;
  }
  if (upstreamRes.status === 429 || upstreamRes.status >= 500) { ... continue; }
  // handleEmbeddings 只写 `: 鉴权失败`，缺状态码
  ```
- **建议模块**：`proxy.js` 内部抽一个 `forwardWithFailover(...)`，前三个 handler 改为薄封装；`handleForward` 的调用点已能复用
- **风险**：中等偏差风险——`handleEmbeddings` 的 401 分支已与其它两个出现措辞漂移；未来加新转发端点（如 `v1/audio`）会继续复制
- **工作量**：`M`

#### 详细改造步骤（H1）

1. 在 `proxy.js` 中新增一个统一函数：
   ```js
   async function forwardWithFailover({ keyEntries, method, upstreamPath, body, reqHeaders, res }) {
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
         // 统一状态分类
         if (upstreamRes.status === 401 || upstreamRes.status === 403) {
           lastError = `${keyEntry.name}: 鉴权失败(${upstreamRes.status})`;
           continue;
         }
         if (upstreamRes.status === 429 || upstreamRes.status >= 500) {
           const errText = await upstreamRes.text().catch(() => '');
           lastError = `${keyEntry.name}: 上游错误(${upstreamRes.status}) ${errText.slice(0, 200)}`;
           continue;
         }
         const errText = await upstreamRes.text().catch(() => '');
         lastError = `${keyEntry.name}: HTTP ${upstreamRes.status} ${errText.slice(0, 200)}`;
         continue;
       } catch (err) {
         lastError = `${keyEntry.name}: ${toErrorMessage(err)}`;
         continue;
       }
     }
     sendJson(res, 502, {
       error: { message: `所有 API Key 均不可用。最后错误: ${lastError || '未知错误'}`, type: 'server_error' },
     });
   }
   ```
   > 注：`toErrorMessage` 见 M2 步骤；此函数统一定义 `keyEntries` 入参，供各 handler 传入 `getCandidateKeys(body)` 的结果。
2. 将 `handleChatCompletions` 的循环体替换为：
   ```js
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
   ```
3. 同样替换 `handleEmbeddings`（`upstreamPath: 'v1/embeddings'`）与 `handleMessages`（`upstreamPath: 'v1/messages'`）。
4. 将 `handleForward` 内部循环也替换为对 `forwardWithFailover` 的调用（保留其 `method/upstreamPath` 参数透传）。
5. 若某个端点确需不同的 401/403 行为（当前未见），可在 `forwardWithFailover` 增加可选 `onStatus` 回调，避免复制整个循环。
6. 验证：启动代理后，对 `/v1/chat/completions`、`/v1/embeddings`、`/v1/messages`、`/v1/images/generations` 等端点做一次「坏 key → 好 key」的故障转移回归测试，确认 503/502 语义与透传一致。

---

### H2 · exactCopy · `normalizeBaseUrl` 完全重复

- **位置**：`main.js` L210 与 `providers.js` L68
- **分层**：main + main 共享模块（跨文件同一进程）
- **证据**：两处函数体逐字符一致：
  ```js
  // main.js:210
  function normalizeBaseUrl(baseUrl) {
    return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  }
  // providers.js:68
  function normalizeBaseUrl(baseUrl) {
    return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  }
  ```
- **建议模块**：`providers.js` 导出 `normalizeBaseUrl`，`main.js` 复用
- **风险**：漂移（未来只改其中一处会导致域名规范化不一致）
- **工作量**：`S`

#### 详细改造步骤（H2）

1. 在 `providers.js` 的 `module.exports` 中追加导出：
   ```js
   module.exports = { PROVIDERS, PROVIDER_LIST, getByPath, normalizeBaseUrl };
   ```
2. 在 `main.js` 删除本地 `normalizeBaseUrl` 函数定义（L210-212）。
3. 在 `main.js` 顶部解构引入：
   ```js
   const { PROVIDERS, PROVIDER_LIST, normalizeBaseUrl } = require('./providers');
   ```
4. 检查 `main.js` 中唯一使用点 `fetchUpstreamModels`（L219）正常引用即可。
5. 验证：`npm start` 后点「连接测试」/「获取模型」，对比改造前后模型列表一致。

---

### M1 · extractShared · baseUrl 解析分散手写

- **位置**：`main.js` L150 / L184 / L235 / L273 共 4 处；`proxy.js` L50 已有 `resolveBaseUrl`
- **分层**：main + main（proxy）
- **证据**：`main.js` 四个 IPC handler 反复写 `const baseUrl = item.baseUrl || provider.defaultBaseUrl;`，而 `proxy.js` 的 `resolveBaseUrl(keyEntry)` 已封装相同语义（还带 `trim()` 与 `defaultBaseUrl` 兜底）。两处实现细节略有差别（`main.js` 未 `trim`，且对 custom 有分支判断），属同源但未共用。
- **建议模块**：`store.js` 或 `shared/` 下的 `resolveBaseUrl(keyEntry, PROVIDERS)`；`main.js` 与 `proxy.js` 同源
- **风险**：无安全暴露，但未来改默认值策略需改多处
- **工作量**：`S`

#### 详细改造步骤（M1）

1. 在 `providers.js` 增加并导出：
   ```js
   function resolveBaseUrl(keyEntry) {
     const base = (keyEntry.baseUrl || '').trim();
     if (base) return base;
     const provider = PROVIDERS[(keyEntry || {}).provider];
     return (provider && provider.defaultBaseUrl) || '';
   }
   ```
   （该实现与 `proxy.js` 现有 `resolveBaseUrl` 一致；为避免 `providers.js` 与 `proxy.js` 循环依赖，把该函数放在 `providers.js`，`proxy.js` 改为从 `providers` 引入后删除自己的定义。）
2. 更新 `main.js` 四个 handler，将：
   ```js
   const baseUrl = item.baseUrl || provider.defaultBaseUrl;
   ```
   替换为：
   ```js
   const baseUrl = resolveBaseUrl(item);
   ```
3. 保留 `main.js` 中 `if (!baseUrl && item.provider !== 'custom')` 这类 custom 特判（可用 `item.provider !== 'custom'` 判断，逻辑不变）。
4. `proxy.js` 中删除本地 `resolveBaseUrl`（L50-55），改从 `providers` 引入已导出的同名函数，删除 `PROVIDERS` 的重复 require（L6）。
5. 验证：编辑一个 baseUrl 留空的 DeepSeek key（应回退默认 `https://api.deepseek.com`），以及一个 baseUrl 带尾斜杠/`/v1` 的 key，在查询与代理转发两条路径上确认 URL 一致。

---

### M2 · nearDuplicate · `AbortError → 请求超时` 映射重复 7 处

- **位置**：`main.js` L166 / L197 / L570；`proxy.js` L256 / L308 / L357 / L465
- **分层**：main + main（proxy）
- **证据**：全部为同一表达式 `err && err.name === 'AbortError' ? '请求超时' : (err.message || String(err))`（`main.js:570` 尾括号略有差异）。
- **建议模块**：共享工具 `toErrorMessage(err)`，置于 `providers.js` 或 `shared/`
- **风险**：无
- **工作量**：`S`

#### 详细改造步骤（M2）

1. 在 `shared/`（若未建则放 `providers.js`）新增并导出：
   ```js
   function toErrorMessage(err) {
     if (!err) return '未知错误';
     return err.name === 'AbortError' ? '请求超时' : (err.message || String(err));
   }
   ```
   > 该函数统一处理 `null/undefined`，所有调用点均可安全替换。
2. `main.js`：将 L166、L197、L570 的 `const msg = err && err.name === 'AbortError' ? ... : ...` 替换为 `const msg = toErrorMessage(err);`。
3. `proxy.js`：将 L256、L308、L357、L465 四个 catch 块内同样替换。
4. `main.js` 顶部与 `proxy.js` 顶部补充 `toErrorMessage` 的引入。
5. 验证：模拟一次超时（如把 `fetchWithTimeout` 超时调小）与一次普通报错，分别确认文案「请求超时」与错误消息正确。

---

### M3 · extractShared · IPC 通道未共享

- **位置**：`main.js` 全部 `ipcMain.handle('...')` 与 `preload.js` 全部 `ipcRenderer.invoke('...')`；通道共约 24 个字符串
- **分层**：main + preload
- **证据**：通道名如 `'keys:query'`、`'server:start'`、`'routes:set'` 在两侧手写对应，无共享 `channels.js` 常量表，一旦改一侧会静默失配。
- **建议模块**：`shared/ipc-channels.js`（若将来上 TypeScript 则 `channels.ts`）
- **风险**：IPC 边界漂移
- **工作量**：`M`

> 说明：目前该仓库没有 `shared/` 目录。若不想新增共享目录，可在 `preload.js` 顶部定义一个 `const CHANNELS = {...}` 并让 `main.js` 引入，或建立 `shared/ipc-channels.js` 被两侧共同引入。两种方式二选一。

#### 详细改造步骤（M3，以新增 `shared/ipc-channels.js` 为例）

1. 新建 `shared/ipc-channels.js`：
   ```js
   'use strict';
   module.exports = {
     providersList: 'providers:list',
     keysList: 'keys:list',
     keysAdd: 'keys:add',
     keysAddBatch: 'keys:addBatch',
     keysUpdate: 'keys:update',
     keysDelete: 'keys:delete',
     keysDedup: 'keys:dedup',
     keysQuery: 'keys:query',
     keysQueryAll: 'keys:queryAll',
     keysModels: 'keys:models',
     keysTest: 'keys:test',
     serverStart: 'server:start',
     serverStop: 'server:stop',
     serverStatus: 'server:status',
     serverGetUnifiedKey: 'server:getUnifiedKey',
     serverRegenerateKey: 'server:regenerateKey',
     serverGetPort: 'server:getPort',
     routesGet: 'routes:get',
     routesSet: 'routes:set',
     routesClear: 'routes:clear',
     updateCheck: 'update:check',
     updateInstall: 'update:install',
     updateGetVersion: 'update:getVersion',
     updateStatus: 'update:status', // main→renderer 推送事件
   };
   ```
2. `package.json` 的 `build.files` 中追加 `"shared/**/*"`，确保打包包含该目录。
3. `main.js`：`const CH = require('./shared/ipc-channels');`，将所有 `ipcMain.handle('xxx', ...)` 第一参数改为 `CH.xxx`；`sendUpdateStatus()` 内 `mainWindow.webContents.send('update:status', ...)` 改为 `CH.updateStatus`。
4. `preload.js`：`const CH = require('./shared/ipc-channels');`，将所有 `ipcRenderer.invoke('...')` 与 `ipcRenderer.on('update:status', ...)` 改为引用 `CH.*`。
5. 验证：全量走一遍 UI 的 增/删/去重/查询/测试/模型/代理启停/路由/更新 操作，确认所有 IPC 正常。

---

### M4 · nearDuplicate · fetch 超时封装同构

- **位置**：`providers.js` L19 `fetchWithTimeout`；`proxy.js` L194 `tryUpstream`
- **分层**：main + main（proxy）
- **证据**：两者都用 `new AbortController()` + `setTimeout(() => controller.abort(), t)` + `finally { clearTimeout(timer) }` 包裹 fetch，仅超时时长（15s vs 60s）与是否传 body/headers 不同。
- **建议模块**：`shared/`（或 `providers.js`）导出 `fetchWithTimeout(url, options, timeoutMs)`，`tryUpstream` 复用之
- **风险**：无
- **工作量**：`S`

#### 详细改造步骤（M4）

1. 确认 `providers.js` 的 `fetchWithTimeout(url, options = {}, timeoutMs = 15000)` 通用性足够，并在 `module.exports` 中追加导出（若想统一超时时长，可加参数，不影响现有调用）。
2. `proxy.js` 的 `tryUpstream` 改造为复用：
   ```js
   async function tryUpstream(keyEntry, method, path, reqBody, reqHeaders, { stream = false } = {}) {
     const url = getUpstreamUrl(keyEntry, path);
     const headers = buildUpstreamHeaders({ headers: reqHeaders }, keyEntry);
     return fetchWithTimeout(url, {
       method,
       headers,
       body: method !== 'GET' && method !== 'HEAD' ? reqBody : undefined,
     }, 60000);
   }
   ```
   （删除本地 AbortController/timer 逻辑，`proxy.js` 顶部引入 `fetchWithTimeout`；`stream` 参数当前未被调用方使用，可保留占位或一并清理。）
3. 需注意 `tryUpstream` 原实现清空 timer 在 finally 中；`fetchWithTimeout` 已含该 `finally`，行为等值。
4. 验证：发一个会导致 60s 内不返回的请求（或临时把超时调小），确认代理返回「请求超时」文案且无资源泄漏。

---

### L1 · nearDuplicate · 跳转跟随 / 跳过证书逻辑

- **位置**：`main.js` L373 `httpsGet` 与 L485 `request`（`downloadInstaller` 内）
- **分层**：main
- **证据**：两处都实现「redirectCount > 5 报错 → 跟随 location → `rejectUnauthorized: false`」，但一个 resolve 响应、一个写文件流，仅有少量复制。
- **建议模块**：抽 `httpsGet(url, { headers, timeout, onResponse, onData })` 或把下载改为复用 `httpsGet` 后流入文件
- **风险**：低
- **工作量**：`M`

#### 详细改造步骤（L1）

1. 泛化 `httpsGet(url, options = {}, redirectCount = 0)`，追加一个可选 `onData` 回调用于流式接收：
   ```js
   function httpsGet(url, options = {}, redirectCount = 0) {
     // ...原逻辑...
     res.on('data', (chunk) => { if (options.onData) options.onData(chunk); });
     // resolve(res) 保持不变
   }
   ```
2. `downloadInstaller` 的 `request(url, redirectCount)` 内部重定向逻辑删除，改为：
   ```js
   const res = await httpsGet(assetUrl, {
     headers: { 'User-Agent': 'keyhub-updater' },
     timeout: 300000,
     onData: (chunk) => {
       fileStream.write(chunk);
       received += chunk.length;
       if (contentLength > 0) {
         updateInfo = { ...updateInfo, progress: Math.round((received / contentLength) * 100) };
         sendUpdateStatus();
       }
     },
   });
   if (res.statusCode !== 200) throw new Error(`下载失败 HTTP ${res.statusCode}`);
   ```
3. 保留 `done/fail` 守卫（settled 标志）与 `fileStream.on('finish')` 完成信号。
4. 验证：触发一次更新下载，确认进度回调、最终 `downloaded: true` 与重定向跟随正常。

---

### L2 · nearDuplicate · provider queryBalance 骨架同构

- **位置**：`providers.js` 多个 provider（deepseek / zhipu / siliconflow / moonshot / openrouter / custom）
- **分层**：main 共享模块
- **证据**：每个 `queryBalance` 都是「fetch → !ok 抛 `HTTP n` → tryJson → 解析字段」。可抽象为一个小 helper `fetchBalance(url, header, extractFn)`。
- **建议模块**：`providers.js` 内部抽 `queryBalanceGeneric(url, auth, extract)` 或共享 `tryJson`+`fetchWithTimeout`
- **风险**：低（不跨进程）
- **工作量**：`S`

#### 详细改造步骤（L2）

1. 在 `providers.js` 内新增 helper：
   ```js
   async function fetchBalance(url, { headers, timeoutMs = 15000, parse = tryJson, getValue = (json) => json } = {}) {
     const res = await fetchWithTimeout(url, { headers }, timeoutMs);
     if (!res.ok) throw new Error(`HTTP ${res.status}`);
     const json = await parse(res);
     if (!json) throw new Error('响应非 JSON');
     return getValue(json);
   }
   ```
2. 将各 provider 的 `queryBalance` 收敛为该 helper 的调用，仅保留各平台不同的 `url` 与 `getValue` 字段提取（例如 deepseek 提取 `balance_infos[0].total_balance + currency`）。把 `tryJson` 作为默认 parse 传参。
3. 保留字段映射处使用的 `?? '0'` / `parseFloat` 兜底，确保缺失字段时回退为 0，不抛错。
   > **模型字段约定**：所有提取函数内字段访问均用 `?.` / `??` 兜底，保持字段**可选**，避免解析中断。
4. 验证：逐个平台分别用有效 key 查询余额，对比改造前后数值/币种一致；对 unsupported 平台确认仍走 `unsupportedBalance`。

---

## 不建议动的项

- `renderer/index.html` 与 `renderer/styles.css`：UI 模板/CSS，属框架层，非去重目标
- `renderer.js` 中 `escapeHtml` / `formatBalance` / `maskKey`：仅 renderer 单层使用，抽到 shared 意义不大（跨进程纯函数可选，但体积小、收益低，保守归入此列）
- `store.js` 的 `addKey` 与 `addKeys`：`addKeys` 是一次读改存 + 编号逻辑，非重复，不去动
- `package-lock.json`、`dist`、`build`：构建产物

## 建议落地顺序

1. **H2** 抽 `normalizeBaseUrl` 到 `providers.js`（最小、零风险的纯函数去重）
2. **H1** 收敛 `proxy.js` 四个故障转移 handler（改动最大但收益最高，注意回归测试故障转移）
3. **M1** 统一定位 `resolveBaseUrl`，替换 `main.js` 四处手写
4. **M2** 引入 `toErrorMessage`，替换 7 处 `AbortError` 映射
5. **M3** 建立共享 IPC channels 常量
6. **M4** 统一 fetch 超时封装
7. **L1** 重构 `httpsGet`/下载跳转
8. **L2** 精简 provider 骨架（可选）

> 落地顺序背后的考虑：SS 级零风险项（H2、M2、M4）可先做以快速收敛；随后做 H1、M1 —— 它们会牵引 M2 的 `toErrorMessage` 引入；M3 属结构性改善，单独一处 commit；L1、L2 收益有限，作为收尾或可选。

## 备注

- 本报告由只读审计 Preset 生成，**未修改任何业务源码**。
- 若涉及 model/DTO 类型的定义（如自定义提供商返回的余额字段），建议字段全部保持**可选**，避免缺字段导致解析失败。
- 该项目 `contextIsolation: true`、`nodeIntegration: false`，preload 暴露面较窄，未发现跨层重复的 contextBridge API 暴露风险；`proxy.js` 中 `timingSafeEqual`/`extractToken` 为单一用途，不重复。
- 后续如需实际落地上述重构，请切换到代码编辑 Preset，并逐簇按「落地顺序」执行，每簇改动后跑一次 `npm start` 冒烟验证。