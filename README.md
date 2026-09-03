# KeyHub — API Key 聚合代理 + 余额查询

个人自用的 API Key 聚合代理 + 余额查询桌面软件，基于 Electron。

将多个 API Key 聚合成一个统一端点 + 一个统一 Key，客户端只需配置一次即可访问所有上游；同时支持查询各平台余额，一目了然。

## 功能

### 1. 聚合代理（核心功能）
- 将所有已配置的 API Key 聚合成**一个统一端点 + 一个统一 Key**
- 客户端只需配置统一端点地址和统一 Key，即可访问所有上游 Key
- **顺序优先 + 故障转移**：按列表顺序依次尝试，某个 Key 失败自动切换到下一个
- 支持流式响应（SSE），兼容 ChatBox、NextChat、OpenAI SDK 等客户端
- 统一 Key 自动生成，可复制、可重新生成
- 支持端点：`/v1/chat/completions`、`/v1/messages`、`/v1/embeddings`、`/v1/models`

### 2. Key 管理 + 余额查询
- 添加 / 编辑 / 删除多个 API Key 配置
- **批量导入**：同一平台多个 Key 一次性粘贴导入，自动去重、连续编号命名
- **一键去重**：扫描已保存的 Key 列表，按 API Key 去除重复条目（保留首次配置）
- 单个查询或一键刷新全部余额
- 本地存储，不上传任何服务器
- 支持提供商：
  - **有余额查询接口**：DeepSeek、智谱、硅基流动、月之暗面 (Kimi)、OpenRouter
  - **仅用于 API 聚合代理（暂无公开余额 API）**：MiniMax、零一万物、百川智能、阿里云百炼 (通义千问)、火山引擎 (豆包)、百度千帆 (文心一言)、腾讯混元、基元律动
  - **通用/自定义**：中转站（OpenAI 兼容，多策略自动探测）、自定义（手动填写接口路径）
- 无论是否支持余额查询，所有平台均可正常用于 API Key 聚合代理，余额查询失败不影响代理功能

### 3. 自动更新
- 应用内一键检查更新（顶栏 🔄 按钮）
- 发现新版本后自动下载，下载完成点击「重启安装」即可更新
- 每次 commit 到 main 分支自动触发 GitHub Actions 构建发布 nightly 版本

## 安装

### 方式一：下载安装包（推荐）

前往 [Releases 页面](https://github.com/ZF3373/api-balance-checker/releases) 下载最新的 `.exe` 安装包，双击安装即可。

### 方式二：从源码运行

```bash
git clone https://github.com/ZF3373/api-balance-checker.git
cd api-balance-checker
npm install
npm start
```

### 方式三：本地打包

```bash
npm install
npm run dist    # 生成 dist/ 目录下的安装包
```

## 使用说明

### 聚合代理

1. 在顶部代理控制区，确认端口号（默认 9527）
2. 点击「启动代理」
3. 启动后会显示：
   - **统一 API Key**：`sk-xxxxxxxx`（点 📋 复制，点 🔄 重新生成）
   - **端点地址**：`http://127.0.0.1:9527/v1`
4. 在客户端（如 ChatBox、NextChat、OpenAI SDK、Anthropic SDK）中配置：
   - API Base URL: `http://127.0.0.1:9527/v1`
   - API Key: 统一 Key
5. 代理会按 Key 列表顺序转发请求，失败自动切换到下一个 Key

### 支持的接口

代理同时支持 OpenAI 和 Anthropic 两种协议，客户端可自由选择：

| 接口 | 方法 | 协议 | 说明 |
|------|------|------|------|
| `/v1/chat/completions` | POST | OpenAI | 对话补全，支持流式（SSE）和工具调用 |
| `/v1/messages` | POST | Anthropic | Anthropic Messages 协议，需传 `anthropic-version` 头和 `max_tokens` |
| `/v1/embeddings` | POST | OpenAI | 向量嵌入 |
| `/v1/models` | GET | OpenAI | 聚合所有上游的模型列表去重返回 |

**OpenAI 协议示例：**
```bash
curl http://127.0.0.1:9527/v1/chat/completions \
  -H "Authorization: Bearer sk_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

**Anthropic 协议示例：**
```bash
curl http://127.0.0.1:9527/v1/messages \
  -H "Authorization: Bearer sk_xxx" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","max_tokens":512,"messages":[{"role":"user","content":"你好"}]}'
```

> 注意：两种协议的流式响应格式不同（OpenAI 用 `choices[0].delta.content`，Anthropic 用原生 Messages 事件），不要混用解析器。

### 余额查询

1. 点击「+ 添加 Key」
2. 填写名称、选择类型、填入 Base URL（留空用默认）和 API Key
3. 保存后点「查询」查看单个余额，或「刷新全部」批量查询

### 批量导入

1. 点击「+ 添加 Key」，在对话框顶部切换到「批量导入」
2. 选择类型、填写 Base URL（所有 Key 共享同一平台配置）
3. 在「名称前缀」填入前缀（留空则用平台名），导入后自动编号（如 `DeepSeek-1`、`DeepSeek-2`）
4. 在文本框中粘贴多个 API Key，每行一个（也支持逗号、分号分隔）
5. 点击「批量导入」，重复的 Key 会自动跳过

### 一键去重

- 点击顶栏「🧹 去重」按钮，扫描已保存的 Key 列表
- 按 API Key 去除重复条目，保留每个 Key 的首次配置
- 适用于长期使用后 Key 列表出现重复时清理

### 检查更新

- 点击顶栏 🔄 按钮检查更新
- 发现新版本后顶部滑出更新条，显示下载进度
- 下载完成后点击「重启安装」一键更新

### 故障转移规则

| 上游响应 | 处理方式 |
|---------|---------|
| 2xx | 直接返回响应 |
| 401/403 | 该 Key 鉴权失败，跳过，试下一个 |
| 429/5xx/超时 | 该 Key 暂时不可用，跳过，试下一个 |
| 其他 4xx | 请求本身有误，直接返回，不重试 |
| 全部失败 | 返回 502 + 最后错误信息 |

## 文件结构

```
api-balance-checker/
├── main.js              # Electron 主进程（窗口 + IPC + 自动更新）
├── preload.js           # 预加载脚本（安全暴露 API）
├── proxy.js             # 聚合代理服务器（鉴权 + 故障转移 + 流式转发）
├── providers.js         # 余额查询逻辑（各提供商适配）
├── store.js             # 本地存储（Key 配置 + 设置）
├── build/icon.svg       # 应用图标
├── .github/workflows/   # CI nightly 构建
├── package.json
└── renderer/
    ├── index.html       # 页面结构
    ├── styles.css       # 深色主题样式
    └── renderer.js      # 前端逻辑
```

## 数据存储

Key 配置和设置保存在 Electron 的 userData 目录下 `keys.json`：

- Windows: `C:\Users\<用户名>\AppData\Roaming\KeyHub\keys.json`

## 说明

- 代理服务器仅监听 `127.0.0.1`，不对外暴露
- API Key 明文存储于本地文件，请勿在公共设备使用
- nightly 版本每次 commit 自动构建，版本号格式 `1.0.0-nightly.YYYYMMDD.sha7`
- 自动更新通过 GitHub API 查询最新 nightly release 并直接下载安装包
