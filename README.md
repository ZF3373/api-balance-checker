# API Key 余额查询（桌面工具）

个人自用的 API Key 聚合管理 + 余额查询桌面软件，基于 Electron。

参考 GitHub [freellmapi](https://github.com/tashfeenahmed/freellmapi) 项目思路，聚焦于「管理多个 API Key + 查询余额」这一核心需求，不做多余功能。

## 功能

- **Key 管理**：添加 / 编辑 / 删除多个 API Key 配置
- **余额查询**：单个查询或一键刷新全部余额
- **本地存储**：Key 配置保存在本地 JSON 文件，不上传任何服务器
- **支持提供商**：
  - DeepSeek（官方，CNY）
  - OpenRouter（USD）
  - 硅基流动 SiliconFlow（CNY）
  - 智谱 GLM（CNY，自动生成 JWT 鉴权）
  - 中转站 / OpenAI 兼容（自动尝试 `credit_grants` 和 `subscription+usage` 两种接口）
  - 自定义（指定余额接口路径 + JSON 提取路径，适配任意接口）

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

1. 启动后点击「+ 添加 Key」
2. 填写名称、选择类型、填入 Base URL（留空用默认）和 API Key
3. 若选「自定义」类型，需填写：
   - 余额接口路径：如 `v1/dashboard/billing/credit_grants`
   - JSON 提取路径：如 `data.balance`（用点号分隔，数组用下标如 `balance_infos.0.total_balance`）
   - 货币单位：如 `CNY` / `USD`
4. 保存后点「查询」查看单个余额，或「刷新全部」批量查询
5. 余额、查询时间、异常信息会保存在本地，下次打开仍可见

## 文件结构

```
api-balance-checker/
├── main.js              # Electron 主进程（窗口 + IPC）
├── preload.js           # 预加载脚本（安全暴露 API）
├── providers.js         # 余额查询逻辑（各提供商适配）
├── store.js             # 本地存储（JSON 文件）
├── package.json
├── 启动.bat             # Windows 一键启动
└── renderer/
    ├── index.html       # 页面结构
    ├── styles.css       # 样式
    └── renderer.js      # 前端逻辑
```

## 数据存储位置

Key 配置保存在 Electron 的 userData 目录下 `keys.json`：

- Windows: `C:\Users\<用户名>\AppData\Roaming\api-balance-checker\keys.json`

## 说明

- 本工具仅查询余额，不转发聊天请求
- API Key 明文存储于本地文件，请勿在公共设备使用
- 各提供商余额接口可能调整，若查询失败可改用「自定义」类型手动配置
