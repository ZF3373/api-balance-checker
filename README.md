# API Key 余额查询 + 聚合代理（桌面工具）

个人自用的 API Key 聚合管理 + 余额查询 + 聚合代理桌面软件，基于 Electron。

参考 GitHub [freellmapi](https://github.com/tashfeenahmed/freellmapi) 项目思路，聚焦于「管理多个 API Key + 查询余额 + 聚合成统一端点」这三个核心需求，不做多余功能。

## 功能

### 1. Key 管理 + 余额查询
- 添加 / 编辑 / 删除多个 API Key 配置
- 单个查询或一键刷新全部余额
- 本地存储，不上传任何服务器
- 支持提供商：DeepSeek、OpenRouter、硅基流动、智谱、中转站（OpenAI 兼容）、自定义

### 2. 聚合代理（核心功能）
- 将所有已配置的 API Key 聚合成**一个统一端点 + 一个统一 Key**
- 客户端只需配置统一端点地址和统一 Key，即可访问所有上游 Key
- **顺序优先 + 故障转移**：按列表顺序依次尝试，某个 Key 失败自动切换到下一个
- 支持流式响应（SSE），兼容 ChatBox、NextChat、OpenAI SDK 等客户端
- 统一 Key 自动生成，可复制、可重新生成
- 支持端点：
  - `POST /v1/chat/completions`（带故障转移）
  - `POST /v1/embeddings`（带故障转移）
  - `GET /v1/models`（聚合所有上游模型列表去重返回）

## 启动方式

### 方式一：双击启动

双击 `启动.bat` 即可。

### 方式二：命令行启动

```bash
cd api-balance-checker
npm start
```

> 首次使用需先安装依赖：`npm install`（已安装可跳过）

## 使用说明

### 余额查询

1. 点击「+ 添加 Key」
2. 填写名称、选择类型、填入 Base URL（留空用默认）和 API Key
3. 保存后点「查询」查看单个余额，或「刷新全部」批量查询

### 聚合代理

1. 在顶部代理控制区，确认端口号（默认 9527）
2. 点击「启动代理」
3. 启动后会显示：
   - **统一 API Key**：`sk-xxxxxxxx`（点 📋 复制，点 🔄 重新生成）
   - **端点地址**：`http://127.0.0.1:9527/v1`
4. 在客户端（如 ChatBox、NextChat、OpenAI SDK）中配置：
   - API Base URL: `http://127.0.0.1:9527/v1`
   - API Key: 统一 Key
5. 代理会按 Key 列表顺序转发请求，失败自动切换到下一个 Key

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
├── main.js              # Electron 主进程（窗口 + IPC）
├── preload.js           # 预加载脚本（安全暴露 API）
├── proxy.js             # 聚合代理服务器（鉴权 + 故障转移 + 流式转发）
├── providers.js         # 余额查询逻辑（各提供商适配）
├── store.js             # 本地存储（Key 配置 + 设置）
├── package.json
├── 启动.bat             # Windows 一键启动
└── renderer/
    ├── index.html       # 页面结构
    ├── styles.css       # 样式
    └── renderer.js      # 前端逻辑
```

## 数据存储

Key 配置和设置保存在 Electron 的 userData 目录下 `keys.json`：

- Windows: `C:\Users\<用户名>\AppData\Roaming\api-balance-checker\keys.json`

## 说明

- 代理服务器仅监听 `127.0.0.1`，不对外暴露
- API Key 明文存储于本地文件，请勿在公共设备使用
- 各提供商余额接口可能调整，若查询失败可改用「自定义」类型手动配置
- 代理支持的客户端：任何兼容 OpenAI API 格式的工具（ChatBox、NextChat、OpenAI SDK、LangChain 等）
