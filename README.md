# napcat-plugin-openclaw

将 QQ 变为 [OpenClaw](https://openclaw.ai) AI 助手通道。

通过 OpenClaw Gateway 的 WebSocket RPC 协议（`chat.send`）通信，所有斜杠命令由 Gateway 统一处理，与 TUI / Telegram 体验完全一致。

## ✨ 功能

- **私聊全透传** — 白名单内用户的私聊消息直接转发给 OpenClaw Agent
- **群聊 @触发** — 群聊中仅 @bot 时触发回复
- **斜杠命令** — `/status`、`/model`、`/think`、`/verbose`、`/new`、`/stop` 等，与 OpenClaw TUI 完全一致
- **输入状态** — 私聊中显示"对方正在输入..."
- **CLI 回退** — Gateway WS 断连时自动回退到 `openclaw agent` CLI
- **长消息分片** — 超长回复自动分段发送

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
| `openclaw.cliPath` | openclaw CLI 路径（回退用） | `/root/.nvm/.../openclaw` |
| `behavior.privateChat` | 是否接收私聊消息 | `true` |
| `behavior.groupAtOnly` | 群聊仅 @bot 触发 | `true` |
| `behavior.userWhitelist` | 用户白名单（QQ号数组） | `[]`（全部允许） |
| `behavior.groupWhitelist` | 群白名单（群号数组） | `[]`（全部允许） |

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

插件通过 Gateway 的 `chat.send` RPC 方法发送消息，监听 `chat` event 的 `final` 帧获取完整回复（非流式，一次性返回）。认证使用 challenge-response 协议。

## 📝 License

MIT
