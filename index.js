// NapCat Plugin: OpenClaw QQ Channel
// 通过 WebSocket RPC 协议与 OpenClaw Gateway 通信
// 支持 chat.send（gateway 自动处理斜杠命令）

import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';

const execAsync = promisify(exec);

// ========== 配置 ==========
let logger = null;
let configPath = null;
let botUserId = null;

const sessionEpochs = new Map();
const activeTasks = new Map(); // sessionBase -> { abortController, runId }

let currentConfig = {
  openclaw: {
    token: '6696ec274e281ab8dcb13d6c597f46eaac874c4cc3329b66ac56da7ddca52550',
    gatewayUrl: 'ws://127.0.0.1:18789'
  },
  behavior: {
    privateChat: true,
    groupAtOnly: true,
    userWhitelist: [768295235],
    groupWhitelist: [902106123]
  }
};

// ========== Gateway WS RPC Client ==========

class GatewayClient {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.ws = null;
    this.pending = new Map(); // id -> { resolve, reject }
    this.eventHandlers = new Map(); // event -> handler
    this.connected = false;
    this.connectPromise = null;
    this.reconnectTimer = null;
    this.connectNonce = null;
  }

  async connect() {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('connect timeout'));
        this.connectPromise = null;
      }, 15000);

      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        clearTimeout(timeout);
        this.connectPromise = null;
        reject(e);
        return;
      }

      this.ws.on('open', () => {
        logger?.info('[OpenClaw] WS 已连接，等待 challenge...');
      });

      this.ws.on('message', (data) => {
        try {
          const frame = JSON.parse(data.toString());
          this._handleFrame(frame, resolve, reject, timeout);
        } catch (e) {
          logger?.error(`[OpenClaw] 解析帧失败: ${e.message}`);
        }
      });

      this.ws.on('close', (code, reason) => {
        logger?.info(`[OpenClaw] WS 关闭: ${code} ${reason}`);
        this.connected = false;
        this.connectPromise = null;
        // reject all pending
        for (const [id, p] of this.pending) {
          p.reject(new Error(`ws closed: ${code}`));
        }
        this.pending.clear();
      });

      this.ws.on('error', (err) => {
        logger?.error(`[OpenClaw] WS 错误: ${err.message}`);
        clearTimeout(timeout);
        this.connected = false;
        this.connectPromise = null;
        reject(err);
      });
    });

    return this.connectPromise;
  }

  _handleFrame(frame, connectResolve, connectReject, connectTimeout) {
    // 1. Challenge event
    if (frame.type === 'event' && frame.event === 'connect.challenge') {
      this.connectNonce = frame.payload?.nonce;
      logger?.info(`[OpenClaw] 收到 challenge, nonce=${this.connectNonce?.slice(0, 8)}...`);
      this._sendConnect(connectResolve, connectReject, connectTimeout);
      return;
    }

    // Response to a pending request
    if (frame.type === 'res' && frame.id) {
      const pending = this.pending.get(frame.id);
      if (pending) {
        if (frame.ok !== false) {
          // If expectFinal, skip "accepted"/"started" and wait for final response
          if (pending.expectFinal && (frame.payload?.status === 'accepted' || frame.payload?.status === 'started')) return;
          this.pending.delete(frame.id);
          pending.resolve(frame.payload);
        } else {
          this.pending.delete(frame.id);
          pending.reject(new Error(frame.error?.message || `request failed: ${JSON.stringify(frame.error)}`));
        }
      }
      return;
    }

    // 3. Events (chat, agent, tick, etc.)
    if (frame.type === 'event' && frame.event) {
      if (frame.event === 'tick') return; // ignore heartbeat ticks
      const handler = this.eventHandlers.get(frame.event);
      if (handler) handler(frame.payload);
      return;
    }
  }

  _sendConnect(resolve, reject, timeout) {
    const id = randomUUID();
    const params = {
      minProtocol: 1,
      maxProtocol: 3,
      client: {
        id: 'gateway-client',
        displayName: 'QQ Channel',
        version: '1.0.0',
        platform: 'linux',
        mode: 'backend'
      },
      caps: [],
      auth: {
        token: this.token
      },
      role: 'operator',
      scopes: ['operator.admin']
    };

    const frame = { type: 'req', id, method: 'connect', params };

    // 注册 pending handler
    this.pending.set(id, {
      resolve: (payload) => {
        clearTimeout(timeout);
        this.connected = true;
        this.connectPromise = null;
        logger?.info('[OpenClaw] Gateway 认证成功');
        resolve();
      },
      reject: (err) => {
        clearTimeout(timeout);
        this.connected = false;
        this.connectPromise = null;
        logger?.error(`[OpenClaw] Gateway 认证失败: ${err.message}`);
        reject(err);
      }
    });

    this.ws.send(JSON.stringify(frame));
    logger?.info('[OpenClaw] 已发送 connect 请求');
  }

  async request(method, params, opts) {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    const id = randomUUID();
    const frame = { type: 'req', id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timeout: ${method}`));
      }, 180000); // 3 min timeout

      this.pending.set(id, {
        resolve: (payload) => { clearTimeout(timeout); resolve(payload); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
        expectFinal: opts?.expectFinal,
      });

      this.ws.send(JSON.stringify(frame));
    });
  }

  disconnect() {
    if (this.ws) {
      try { this.ws.close(1000, 'plugin cleanup'); } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.connectPromise = null;
  }
}

let gatewayClient = null;

async function getGateway() {
  if (!gatewayClient) {
    gatewayClient = new GatewayClient(
      currentConfig.openclaw.gatewayUrl,
      currentConfig.openclaw.token
    );
  }
  if (!gatewayClient.connected) {
    await gatewayClient.connect();
  }
  return gatewayClient;
}

// ========== 斜杠命令（仅插件本地处理的） ==========

function cmdHelp() {
  return [
    'ℹ️ Help',
    '',
    'Session',
    '  /new  |  /clear  |  /stop',
    '',
    'Options',
    '  /think <level>  |  /model <id>  |  /verbose on|off',
    '',
    'Status',
    '  /status  |  /whoami  |  /context',
    '',
    '所有 OpenClaw 命令均可直接使用',
    '更多: /commands'
  ].join('\n');
}

function cmdWhoami(sessionBase, userId, nickname, messageType, groupId) {
  return [
    `👤 ${nickname}`,
    `QQ: ${userId}`,
    `类型: ${messageType === 'private' ? '私聊' : `群聊 (${groupId})`}`,
    `Session: ${getSessionKey(sessionBase)}`
  ].join('\n');
}

// 仅这些命令在插件本地处理
const LOCAL_COMMANDS = {
  '/help': cmdHelp,
  '/whoami': cmdWhoami,
};

// ========== Session 管理 ==========

function getSessionBase(messageType, userId, groupId) {
  if (messageType === 'private') return `qq-${userId}`;
  return `qq-g${groupId}-${userId}`;
}

function getSessionKey(sessionBase) {
  const epoch = sessionEpochs.get(sessionBase) || 0;
  return epoch > 0 ? `${sessionBase}-${epoch}` : sessionBase;
}

// ========== 生命周期 ==========

const plugin_init = async (ctx) => {
  logger = ctx.logger;
  configPath = ctx.configPath;
  logger.info('[OpenClaw] QQ Channel 插件初始化中...');

  try {
    if (configPath && fs.existsSync(configPath)) {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      currentConfig = deepMerge(currentConfig, saved);
      logger.info('[OpenClaw] 已加载保存的配置');
    }
  } catch (e) {
    logger.warn('[OpenClaw] 加载配置失败: ' + e.message);
  }

  // 预连接 Gateway
  try {
    await getGateway();
    logger.info('[OpenClaw] Gateway 连接就绪');
  } catch (e) {
    logger.error(`[OpenClaw] Gateway 预连接失败: ${e.message}（将在首次消息时重试）`);
  }

  logger.info(`[OpenClaw] 网关: ${currentConfig.openclaw.gatewayUrl}`);
  logger.info('[OpenClaw] 模式: 私聊全透传 + 群聊@触发 + 命令透传');
  logger.info('[OpenClaw] QQ Channel 插件初始化完成');
};

const plugin_onmessage = async (ctx, event) => {
  try {
    if (!logger) return;
    if (event.post_type !== 'message') return;

    const userId = event.user_id;
    const nickname = event.sender?.nickname || '未知';
    const messageType = event.message_type;
    const groupId = event.group_id;

    if (!botUserId && event.self_id) {
      botUserId = event.self_id;
      logger.info(`[OpenClaw] Bot QQ: ${botUserId}`);
    }

    // 用户白名单检查
    const userWhitelist = currentConfig.behavior.userWhitelist;
    if (userWhitelist.length > 0) {
      const userIdNum = Number(userId);
      if (!userWhitelist.some(id => Number(id) === userIdNum)) return;
    }

    let shouldHandle = false;

    if (messageType === 'private') {
      if (!currentConfig.behavior.privateChat) return;
      shouldHandle = true;
    } else if (messageType === 'group') {
      if (!groupId) return;
      const whitelist = currentConfig.behavior.groupWhitelist;
      if (whitelist.length > 0 && !whitelist.some(id => Number(id) === Number(groupId))) return;
      if (currentConfig.behavior.groupAtOnly) {
        const isAtBot = event.message?.some(
          seg => seg.type === 'at' && String(seg.data?.qq) === String(botUserId || event.self_id)
        );
        if (!isAtBot) return;
      }
      shouldHandle = true;
    }

    if (!shouldHandle) return;

    // 提取消息内容
    const { extractedText, extractedMedia } = extractMessage(event.message || []);
    const text = extractedText;

    if (!text && extractedMedia.length === 0) return;

    const sessionBase = getSessionBase(messageType, userId, groupId);

    // ====== 插件本地命令 ======
    if (text && text.startsWith('/')) {
      const spaceIdx = text.indexOf(' ');
      const cmd = spaceIdx > 0 ? text.slice(0, spaceIdx).toLowerCase() : text.toLowerCase();
      const args = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : '';

      if (LOCAL_COMMANDS[cmd]) {
        logger.info(`[OpenClaw] 本地命令: ${cmd} from ${nickname}(${userId})`);
        const result = LOCAL_COMMANDS[cmd](sessionBase, userId, nickname, messageType, groupId, args);
        if (result) {
          await sendReply(ctx, messageType, groupId, userId, result);
          return;
        }
      }
      // 其他命令（包括所有 OpenClaw 斜杠命令）都通过 chat.send 发给 gateway
    }

    // ====== 构建消息 ======
    let openclawMessage = text;
    if (extractedMedia.length > 0) {
      const mediaInfo = extractedMedia.map(m => `[${m.type}: ${m.url}]`).join('\n');
      openclawMessage = openclawMessage ? `${openclawMessage}\n\n${mediaInfo}` : mediaInfo;
    }

    logger.info(`[OpenClaw] ${messageType === 'private' ? '私聊' : `群${groupId}`} ${nickname}(${userId}): ${openclawMessage.slice(0, 80)}`);

    // 设置输入状态
    if (messageType === 'private') {
      setTypingStatus(ctx, userId, true);
    }

    // ====== 通过 Gateway RPC chat.send + event 监听 ======
    const sessionKey = getSessionKey(sessionBase);
    const runId = randomUUID();

    try {
      const gw = await getGateway();

      // 设置 chat event 监听（收集完整回复后一次性发送）
      const replyPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          cleanup();
          resolve(null);
        }, 180000);

        const cleanup = () => {
          clearTimeout(timeout);
          gw.eventHandlers.delete('chat');
        };

        gw.eventHandlers.set('chat', (payload) => {
          if (!payload) return;
          logger?.info(`[OpenClaw] chat event: state=${payload.state} session=${payload.sessionKey} run=${payload.runId?.slice(0,8)}`);
          if (payload.sessionKey !== sessionKey) return;

          if (payload.state === 'final') {
            // final 包含完整回复文本
            const text = extractContentText(payload.message);
            cleanup();
            resolve(text?.trim() || null);
          }

          if (payload.state === 'aborted') {
            cleanup();
            resolve('⏹ 已中止');
          }

          if (payload.state === 'error') {
            cleanup();
            resolve(`❌ ${payload.errorMessage || '处理出错'}`);
          }
        });
      });

      // 发送消息
      const sendResult = await gw.request('chat.send', {
        sessionKey,
        message: openclawMessage,
        idempotencyKey: runId
      });

      logger.info(`[OpenClaw] chat.send 已接受: runId=${sendResult?.runId}`);

      // 等待 event 回复
      const reply = await replyPromise;

      if (reply) {
        await sendReply(ctx, messageType, groupId, userId, reply);
      } else {
        logger.info('[OpenClaw] 无回复内容');
      }

    } catch (e) {
      logger.error(`[OpenClaw] 发送失败: ${e.message}`);
      if (gatewayClient) {
        gatewayClient.disconnect();
        gatewayClient = null;
      }
      try {
        const escapedMessage = openclawMessage.replace(/'/g, "'\\''");
        const { stdout } = await execAsync(
          `OPENCLAW_TOKEN='${currentConfig.openclaw.token}' /root/.nvm/versions/node/v22.22.0/bin/openclaw agent --session-id '${sessionKey}' --message '${escapedMessage}' 2>&1`,
          { timeout: 180000, maxBuffer: 1024 * 1024 }
        );
        if (stdout.trim()) {
          await sendReply(ctx, messageType, groupId, userId, stdout.trim());
        }
      } catch (e2) {
        await sendReply(ctx, messageType, groupId, userId, `处理出错: ${e.message?.slice(0, 100)}`);
      }
    }

  } catch (outerErr) {
    logger?.error(`[OpenClaw] 未捕获异常: ${outerErr.message}\n${outerErr.stack}`);
  }
};

const plugin_cleanup = async () => {
  if (gatewayClient) {
    gatewayClient.disconnect();
    gatewayClient = null;
  }
  logger?.info('[OpenClaw] QQ Channel 插件清理完成');
};

// ========== 消息提取 ==========

// 从 chat event payload.message 提取文本
// 格式: { role: "assistant", content: [{ type: "text", text: "..." }] }
function extractContentText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;

  const content = message.content;
  if (!content) return '';

  const blocks = Array.isArray(content) ? content : [content];
  let text = '';
  for (const b of blocks) {
    if (typeof b === 'string') text += b;
    else if (b?.type === 'text' && b?.text) text += b.text;
    else if (b?.text) text += b.text;
  }
  return text;
}

function extractTextFromPayload(message) {
  if (typeof message === 'string') return message;
  if (!message) return '';

  // content block format
  const content = message.content;
  if (!content) {
    // Try direct text field
    if (typeof message.text === 'string') return message.text;
    return '';
  }

  const blocks = Array.isArray(content) ? content : [content];
  let text = '';
  for (const b of blocks) {
    if (typeof b === 'string') text += b;
    else if (b?.text) text += b.text;
  }
  return text;
}

function extractMessage(segments) {
  const textParts = [];
  const media = [];

  for (const seg of segments) {
    switch (seg.type) {
      case 'text': {
        const t = seg.data?.text?.trim();
        if (t) textParts.push(t);
        break;
      }
      case 'image':
        if (seg.data?.url) media.push({ type: 'image', url: seg.data.url });
        break;
      case 'at':
        if (String(seg.data?.qq) !== String(botUserId)) {
          textParts.push(`@${seg.data?.name || seg.data?.qq}`);
        }
        break;
      case 'file':
        if (seg.data?.url) media.push({ type: 'file', url: seg.data.url, name: seg.data?.name });
        break;
      case 'record':
        if (seg.data?.url) media.push({ type: 'voice', url: seg.data.url });
        break;
      case 'video':
        if (seg.data?.url) media.push({ type: 'video', url: seg.data.url });
        break;
      default:
        break;
    }
  }

  return { extractedText: textParts.join(' '), extractedMedia: media };
}

// ========== 输入状态 ==========

async function setTypingStatus(ctx, userId, typing) {
  try {
    await ctx.actions.call('set_input_status', {
      user_id: String(userId),
      event_type: typing ? 1 : 0
    }, ctx.adapterName, ctx.pluginManager?.config);
  } catch (e) {
    logger?.warn(`[OpenClaw] 设置输入状态失败: ${e.message}`);
  }
}

// ========== 消息发送 ==========

async function sendReply(ctx, messageType, groupId, userId, text) {
  if (messageType === 'group') {
    await sendGroupMsg(ctx, groupId, text);
  } else {
    await sendPrivateMsg(ctx, userId, text);
  }
}

async function sendGroupMsg(ctx, groupId, text) {
  const maxLen = 3000;
  if (text.length <= maxLen) {
    await ctx.actions.call('send_group_msg', {
      group_id: String(groupId),
      message: text
    }, ctx.adapterName, ctx.pluginManager?.config);
  } else {
    for (let i = 0; i < text.length; i += maxLen) {
      const part = text.slice(i, i + maxLen);
      const total = Math.ceil(text.length / maxLen);
      const idx = Math.floor(i / maxLen) + 1;
      const prefix = total > 1 ? `[${idx}/${total}]\n` : '';
      await ctx.actions.call('send_group_msg', {
        group_id: String(groupId),
        message: prefix + part
      }, ctx.adapterName, ctx.pluginManager?.config);
      if (i + maxLen < text.length) await sleep(1000);
    }
  }
}

async function sendPrivateMsg(ctx, userId, text) {
  const maxLen = 3000;
  if (text.length <= maxLen) {
    await ctx.actions.call('send_private_msg', {
      user_id: String(userId),
      message: text
    }, ctx.adapterName, ctx.pluginManager?.config);
  } else {
    for (let i = 0; i < text.length; i += maxLen) {
      const part = text.slice(i, i + maxLen);
      const total = Math.ceil(text.length / maxLen);
      const idx = Math.floor(i / maxLen) + 1;
      const prefix = total > 1 ? `[${idx}/${total}]\n` : '';
      await ctx.actions.call('send_private_msg', {
        user_id: String(userId),
        message: prefix + part
      }, ctx.adapterName, ctx.pluginManager?.config);
      if (i + maxLen < text.length) await sleep(1000);
    }
  }
}

// ========== 工具函数 ==========

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ========== 配置 ==========

let plugin_config_ui = [];
const plugin_get_config = async () => currentConfig;
const plugin_set_config = async (ctx, config) => {
  currentConfig = config;
  // 重连 gateway
  if (gatewayClient) {
    gatewayClient.disconnect();
    gatewayClient = null;
  }
  if (ctx?.configPath) {
    try {
      const dir = path.dirname(ctx.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ctx.configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (e) {
      logger?.error('[OpenClaw] 保存配置失败: ' + e.message);
    }
  }
};

// ========== 导出 ==========

export {
  plugin_init,
  plugin_onmessage,
  plugin_cleanup,
  plugin_config_ui,
  plugin_get_config,
  plugin_set_config
};
