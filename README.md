# napcat-plugin-openclaw

将 QQ 变为 [OpenClaw](https://openclaw.ai) AI 助手通道。

通过 OpenClaw Gateway 的 WebSocket RPC 协议（`chat.send`）通信，所有斜杠命令由 Gateway 统一处理，与 TUI / Telegram 体验完全一致。

## ✨ 功能

- **私聊全透传** — 白名单内用户的私聊消息直接转发给 OpenClaw Agent
- **群聊 @触发** — 群聊中仅 @bot 时触发回复
- **斜杠命令** — `/status`、`/model`、`/think`、`/verbose`、`/new`、`/stop` 等，与 OpenClaw TUI 完全一致
- **图片/文件支持** — QQ 发图/文件自动下载缓存，Agent 可直接读取；Agent 回复中的图片自动发送到 QQ
- **智能分段** — 超长回复按代码块 > 段落 > 句号智能切割，不在代码块中间断开
- **消息防抖** — 快速连发的消息自动合并为一条请求（可配置时间窗口）
- **输入状态** — 私聊中显示"对方正在输入..."
- **WS 心跳自动重连** — 15 秒心跳检测，断线 5 秒后自动重连，无需人工干预
- **Agent 主动推送** — Agent 端向 QQ session 发送的消息自动推送到对应 QQ 用户/群
- **群聊 Session 模式** — 可选每人独立 session 或群共享 session
- **WebUI 配置面板** — 在 NapCat WebUI 中直接配置所有选项
- **Token 脱敏** — WebUI 中 Gateway Token 显示为脱敏格式
- **CLI 回退** — Gateway WS 断连时自动回退到 `openclaw agent` CLI

## 📦 安装

### 方式一：从 Release 下载

1. 前往 [Releases](https://github.com/CharTyr/napcat-plugin-openclaw/releases) 下载最新 zip
2. 解压到 NapCat 插件目录：`napcat/plugins/napcat-plugin-openclaw/`
3. 在插件目录执行 `npm install --production` 安装依赖
4. 重启 NapCat

### 方式二：从源码构建

```bash
git clone https://github.com/CharTyr/napcat-plugin-openclaw.git
cd napcat-plugin-openclaw
pnpm install
pnpm build
# 将 dist/ 目录复制到 napcat/plugins/napcat-plugin-openclaw/
```

## ⚙️ 配置

在 NapCat WebUI 插件配置面板中设置，或编辑配置文件：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `openclaw.token` | OpenClaw Gateway 认证 Token | （必填） |
| `openclaw.gatewayUrl` | Gateway WebSocket 地址 | `ws://127.0.0.1:18789` |
| `behavior.privateChat` | 是否接收私聊消息 | `true` |
| `behavior.groupAtOnly` | 群聊仅 @bot 触发 | `true` |
| `behavior.userWhitelist` | 用户白名单（QQ号，逗号分隔） | 空（全部允许） |
| `behavior.groupWhitelist` | 群白名单（群号，逗号分隔） | 空（全部允许） |
| `behavior.debounceMs` | 消息防抖时长（毫秒） | `2000` |
| `behavior.groupSessionMode` | 群聊 Session 模式 | `user`（每人独立） |

### 群聊 Session 模式

- **`user`**（默认）— 每个群成员拥有独立的对话上下文
- **`shared`** — 整个群共享同一个对话上下文，所有成员的消息都在同一个 session 中

## 🔧 前置要求

- [NapCat](https://github.com/NapNeko/NapCatQQ) >= 4.14.0
- [OpenClaw](https://openclaw.ai) Gateway 运行中（本地或远程）
- Node.js >= 18

## 📋 可用命令

所有 OpenClaw 斜杠命令均可直接使用：

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/new` / `/clear` | 新建对话 |
| `/stop` | 终止当前任务 |
| `/status` | 查看会话状态 |
| `/model <id>` | 查看/切换模型 |
| `/think <level>` | 设置思考级别 |
| `/verbose on\|off` | 切换详细模式 |
| `/context` | 查看上下文信息 |
| `/whoami` | 显示身份信息 |
| `/commands` | 列出全部命令 |

## 🏗️ 技术架构

```
QQ 用户 ←→ NapCat ←→ 本插件 ←→ OpenClaw Gateway (WS RPC)
                                       ↕
                                   AI Agent (Claude, etc.)
```

- **入站消息**：插件通过 Gateway 的 `chat.send` RPC 方法发送消息
- **回复接收**：监听 `chat` event 的 `final` 帧获取完整回复（非流式，一次性返回）
- **图片处理**：下载到插件 `cache/media/` 目录，Agent 通过 `read` tool 直接读取
- **认证协议**：Gateway WS challenge-response 协议
- **心跳机制**：15s ping/pong + 30s 超时检测 + 5s 自动重连
- **并发处理**：按 `runId` 路由 event，支持多消息并发处理

## 📝 License

MIT
