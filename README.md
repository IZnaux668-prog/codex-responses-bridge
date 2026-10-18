# Codex / ChatGPT Desktop Responses API Bridge

一个**零依赖、单文件**的本地协议转换桥，让你在新版 **OpenAI Codex CLI / ChatGPT 桌面端**（强制要求 `wire_api = "responses"`）中，自由使用 **Google Cloud Vertex AI 原生密钥**、**OpenRouter**、**DeepSeek** 或任何兼容 **OpenAI `/v1/chat/completions`**（如 SillyTavern 反代、NewAPI、OneAPI）的第三方 API。

## 为什么需要这个工具？

新版 Codex（`v0.160+` / 现改名为 ChatGPT 桌面端）彻底移除了对 `wire_api = "chat"`（即传统的 `/v1/chat/completions` 接口）的支持，强制所有自定义模型服务商必须支持 OpenAI 专有的 `/v1/responses` 接口（参见官方讨论 `#7782`）。

绝大多数第三方 API、反代工程以及 Google Cloud Vertex AI 均不支持 `/v1/responses`。本项目在本地启动一个超轻量 HTTP 转换服务（无需 `npm install`，仅需 Node.js 原生环境），将 Codex 的 `/v1/responses` 请求（含多轮对话、系统提示词、Function Calling 工具调用）实时转换为：

1. **Google Cloud Vertex AI 原生协议**（支持 `AQ.` / `AIza` 开头的 Vertex Express API Key，自动从报错探测 Project ID 并路由至 `locations/global`，支持 Gemini 思考签名 `thoughtSignature` 缓存与 Schema 自动清洗）。
2. **标准 OpenAI `/v1/chat/completions` 协议**（通吃 OpenRouter、OpenCode Go、DeepSeek、硅基流动及各类自建反代）。

---

## 快速开始

### 1. 环境要求
电脑已安装 [Node.js](https://nodejs.org/)（建议 v18 及以上，无需安装任何第三方 npm 包）。

### 2. 填写你的 API Key
打开项目目录下的 `bridge-config.json`（修改后保存立即生效，无需重启服务）：

```json
{
  "port": 18787,
  "mode": "auto",
  "default_model": "gemini-2.5-pro",
  "vertex_api_version": "v1beta1",
  "vertex_project_id": "",
  "vertex_location": "global",
  "vertex_fallback_model": "gemini-2.5-pro",
  "openai_compat_base_url": "https://openrouter.ai/api/v1",
  "api_key": "在这里填入你的API_KEY"
}
```

- **方式 A：使用 Google Cloud Vertex API Key**（`AQ.` 或 `AIza` 开头）：
  直接将密钥填入 `"api_key"`，`"mode"` 保持 `"auto"` 即可。脚本会自动直连 Google Cloud `aiplatform.googleapis.com` 并自动识别你的 Project ID 与 `global` 区域。
- **方式 B：使用 OpenRouter / 自建反代 / 其他中转站**：
  1. 将 `"openai_compat_base_url"` 改为对应平台的 `/v1` 地址（例如 `https://openrouter.ai/api/v1`）；
  2. 将 `"default_model"` 改为你想调用的模型名称（例如 `anthropic/claude-sonnet-4` 或 `deepseek-chat`）；
  3. 将 `"api_key"` 填入该平台的 Key。

### 3. 启动本地转换桥
- **Windows**：直接双击运行 `start-bridge.bat`
- **命令行（Windows / macOS / Linux）**：
  ```bash
  node server.mjs
  ```
看到 `Codex Responses Bridge listening on http://127.0.0.1:18787/v1` 即表示启动成功。

### 4. 配置 Codex / ChatGPT 桌面端
打开你的 Codex 配置文件 `~/.codex/config.toml`（Windows 下路径为 `C:\Users\<你的用户名>\.codex\config.toml`），在最上方添加：

```toml
model_provider = "vertex"
openai_base_url = "http://127.0.0.1:18787/v1"

[model_providers.vertex]
name = "LocalBridge"
base_url = "http://127.0.0.1:18787/v1"
wire_api = "responses"
supports_websockets = false
stream_idle_timeout_ms = 180000
request_max_retries = 3
```

保存后重新打开 ChatGPT（Codex）即可直接使用！
