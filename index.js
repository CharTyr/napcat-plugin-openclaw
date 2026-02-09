// NapCat Plugin: OpenClaw QQ Channel
// 通过 WebSocket RPC 协议与 OpenClaw Gateway 通信
// 支持 chat.send（gateway 自动处理斜杠命令）

import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
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
    groupWhitelist: [902106123],
    debounceMs: 2000
  }
};

// ========== 防抖 ==========
const debounceBuffers = new Map(); // sessionBase -> { messages: [], media: [], timer, resolve }

function debounceMessage(sessionBase, text, media, debounceMs) {
  return new Promise((resolve) => {
    let buf = debounceBuffers.get(sessionBase);
    if (buf) {
      // 追加到现有 buffer
      if (text) buf.messages.push(text);
      if (media.length > 0) buf.media.push(...media);
      clearTimeout(buf.timer);
      // 替换 resolve：前一个 promise 会 resolve(null) 被跳过
      const prevResolve = buf.resolve;
      buf.resolve = resolve;
      prevResolve(null); // 告诉前一个调用者"被合并了"
    } else {
      buf = {
        messages: text ? [text] : [],
        media: [...media],
        resolve
      };
      debounceBuffers.set(sessionBase, buf);
    }

    buf.timer = setTimeout(() => {
      debounceBuffers.delete(sessionBase);
      buf.resolve({
        text: buf.messages.join('\n'),
        media: buf.media
      });
    }, debounceMs);
  });
}

// ========== Gateway WS RPC Client ==========

class GatewayClient {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.ws = null;
    this.pending = new Map(); // id -> { resolve, reject }
    this.eventHandlers = new Map(); // event -> handler
    this.chatWaiters = new Map(); // runId -> { resolve, cleanup }
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

      // Chat events: route by runId to specific waiters
      if (frame.event === 'chat' && frame.payload?.runId) {
        const waiter = this.chatWaiters.get(frame.payload.runId);
        if (waiter) {
          waiter.handler(frame.payload);
        }
      }

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
  // 插件根目录
  pluginDir = new URL('.', import.meta.url).pathname;
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
    let { extractedText, extractedMedia } = extractMessage(event.message || []);
    let text = extractedText;

    // Debug: 记录未识别的消息段
    if (!text && extractedMedia.length === 0) {
      const rawSegs = (event.message || []).map(s => `${s.type}:${JSON.stringify(s.data).slice(0,120)}`);
      if (rawSegs.length > 0) logger?.info(`[OpenClaw] 未提取到内容，原始段: ${rawSegs.join(' | ')}`);
      return;
    }

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

    // ====== 防抖合并 ======
    const debounceMs = currentConfig.behavior.debounceMs || 0;
    if (debounceMs > 0 && !(text && text.startsWith('/'))) {
      const merged = await debounceMessage(sessionBase, text, extractedMedia, debounceMs);
      if (!merged) {
        // 被合并到后续消息了，跳过
        return;
      }
      // 用合并后的内容替换
      extractedText = merged.text;
      extractedMedia = merged.media;
      text = extractedText;
      if (!text && extractedMedia.length === 0) return;
    }

    // ====== 构建消息 ======
    let openclawMessage = text || '';
    let imageAttachments = [];

    if (extractedMedia.length > 0) {
      // 下载所有媒体到 cache 目录
      const savedMedia = await saveMediaToCache(extractedMedia, ctx);

      if (savedMedia.length > 0) {
        const mediaDescriptions = savedMedia.map(m => {
          if (m.path) {
            if (m.type === 'image') return `[用户发送了图片: ${m.path}]`;
            if (m.type === 'file') return `[用户发送了文件「${m.name}」: ${m.path}]`;
            if (m.type === 'voice') return `[用户发送了语音: ${m.path}]`;
            if (m.type === 'video') return `[用户发送了视频: ${m.path}]`;
            return `[用户发送了${m.type}: ${m.path}]`;
          }
          return `[用户发送了${m.type}: ${m.url}]`;
        });
        const mediaText = mediaDescriptions.join('\n');
        openclawMessage = openclawMessage ? `${openclawMessage}\n\n${mediaText}` : mediaText;
        logger.info(`[OpenClaw] 已保存 ${savedMedia.filter(m => m.path).length} 个媒体文件到 cache`);
      }
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

      // 发送消息（先发，拿到真实 runId）
      const sendResult = await gw.request('chat.send', {
        sessionKey,
        message: openclawMessage,
        idempotencyKey: runId
      });

      const realRunId = sendResult?.runId || runId;
      logger.info(`[OpenClaw] chat.send 已接受: runId=${realRunId}`);

      // 注册按 runId 路由的 waiter
      const replyPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          gw.chatWaiters.delete(realRunId);
          resolve(null);
        }, 180000);

        gw.chatWaiters.set(realRunId, {
          handler: (payload) => {
            logger?.info(`[OpenClaw] chat event: state=${payload.state} run=${realRunId.slice(0,8)}`);

            if (payload.state === 'final') {
              clearTimeout(timeout);
              gw.chatWaiters.delete(realRunId);
              const text = extractContentText(payload.message);
              resolve(text?.trim() || null);
            }

            if (payload.state === 'aborted') {
              clearTimeout(timeout);
              gw.chatWaiters.delete(realRunId);
              resolve('⏹ 已中止');
            }

            if (payload.state === 'error') {
              clearTimeout(timeout);
              gw.chatWaiters.delete(realRunId);
              resolve(`❌ ${payload.errorMessage || '处理出错'}`);
            }
          }
        });
      });

      // 等待 event 回复
      const reply = await replyPromise;

      if (reply) {
        // 提取回复中的图片
        const { images: replyImages, cleanText } = extractImagesFromReply(reply);

        // 先发文本
        if (cleanText) {
          await sendReply(ctx, messageType, groupId, userId, cleanText);
        }

        // 再发图片
        for (const imgUrl of replyImages) {
          try {
            await sendImageMsg(ctx, messageType, groupId, userId, imgUrl);
          } catch (e) {
            logger?.warn(`[OpenClaw] 发送图片失败: ${e.message}`);
          }
        }
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
        if (seg.data?.url) {
          media.push({ type: 'file', url: seg.data.url, name: seg.data?.file || seg.data?.name });
        } else if (seg.data?.file_id) {
          // QQ 文件没有直接 URL，需要通过 API 获取；先记录 file_id
          media.push({ type: 'file', file_id: seg.data.file_id, name: seg.data?.file || seg.data?.name });
        }
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

// ========== 智能分段 ==========

const MAX_CHUNK_LEN = 2000;

function smartSplit(text) {
  if (text.length <= MAX_CHUNK_LEN) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > MAX_CHUNK_LEN) {
    let cutAt = -1;

    // 1. 代码块边界（找最后一个在限制内的 ``` 结束）
    const codeBlockEnd = remaining.lastIndexOf('```\n', MAX_CHUNK_LEN);
    if (codeBlockEnd > MAX_CHUNK_LEN * 0.3) {
      cutAt = codeBlockEnd + 4;
    }

    // 2. 空行（段落边界）
    if (cutAt === -1) {
      const doubleNewline = remaining.lastIndexOf('\n\n', MAX_CHUNK_LEN);
      if (doubleNewline > MAX_CHUNK_LEN * 0.3) {
        cutAt = doubleNewline + 2;
      }
    }

    // 3. 单个换行
    if (cutAt === -1) {
      const singleNewline = remaining.lastIndexOf('\n', MAX_CHUNK_LEN);
      if (singleNewline > MAX_CHUNK_LEN * 0.3) {
        cutAt = singleNewline + 1;
      }
    }

    // 4. 句号/问号/感叹号
    if (cutAt === -1) {
      for (const sep of ['。', '！', '？', '. ', '! ', '? ']) {
        const idx = remaining.lastIndexOf(sep, MAX_CHUNK_LEN);
        if (idx > MAX_CHUNK_LEN * 0.3) {
          cutAt = idx + sep.length;
          break;
        }
      }
    }

    // 5. 硬切
    if (cutAt === -1) cutAt = MAX_CHUNK_LEN;

    chunks.push(remaining.slice(0, cutAt).trimEnd());
    remaining = remaining.slice(cutAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

// ========== 消息发送 ==========

async function sendReply(ctx, messageType, groupId, userId, text) {
  const chunks = smartSplit(text);
  for (let i = 0; i < chunks.length; i++) {
    if (messageType === 'group') {
      await sendGroupMsg(ctx, groupId, chunks[i]);
    } else {
      await sendPrivateMsg(ctx, userId, chunks[i]);
    }
    if (i < chunks.length - 1) await sleep(500);
  }
}

async function sendImageMsg(ctx, messageType, groupId, userId, imageUrl) {
  const message = [{ type: 'image', data: { url: imageUrl } }];
  if (messageType === 'group') {
    await ctx.actions.call('send_group_msg', {
      group_id: String(groupId),
      message
    }, ctx.adapterName, ctx.pluginManager?.config);
  } else {
    await ctx.actions.call('send_private_msg', {
      user_id: String(userId),
      message
    }, ctx.adapterName, ctx.pluginManager?.config);
  }
}

async function sendGroupMsg(ctx, groupId, text) {
  await ctx.actions.call('send_group_msg', {
    group_id: String(groupId),
    message: text
  }, ctx.adapterName, ctx.pluginManager?.config);
}

async function sendPrivateMsg(ctx, userId, text) {
  await ctx.actions.call('send_private_msg', {
    user_id: String(userId),
    message: text
  }, ctx.adapterName, ctx.pluginManager?.config);
}

// ========== 工具函数 ==========

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 下载 URL 到 Buffer（5MB 限制，10 秒超时）
function downloadToBuffer(url, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        downloadToBuffer(res.headers.location, maxBytes).then(resolve, reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          res.destroy();
          reject(new Error(`exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// 从 URL 猜测 MIME 类型
function guessMimeFromUrl(url) {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  return map[ext] || 'image/png';
}

// 下载媒体文件保存到插件 cache 目录，返回文件路径列表
let pluginDir = null;

async function saveMediaToCache(mediaList, ctx) {
  const cacheDir = path.join(pluginDir || '/tmp', 'cache', 'media');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  const saved = [];
  for (const m of mediaList) {
    try {
      let buf = null;

      if (m.url) {
        buf = await downloadToBuffer(m.url, 10 * 1024 * 1024);
      } else if (m.file_id && ctx) {
        // 通过 OneBot API 获取文件
        try {
          const fileInfo = await ctx.actions.call('get_file', {
            file_id: m.file_id
          }, ctx.adapterName, ctx.pluginManager?.config);
          if (fileInfo?.file) {
            // file 可能是本地路径
            if (fs.existsSync(fileInfo.file)) {
              buf = fs.readFileSync(fileInfo.file);
            } else if (fileInfo.url) {
              buf = await downloadToBuffer(fileInfo.url, 10 * 1024 * 1024);
            } else if (fileInfo.base64) {
              buf = Buffer.from(fileInfo.base64, 'base64');
            }
          }
        } catch (e) {
          logger?.warn(`[OpenClaw] get_file 失败: ${e.message}`);
        }
      }

      if (!buf) {
        saved.push({ type: m.type, path: null, url: m.url, name: m.name });
        continue;
      }
      let ext = 'bin';
      if (m.type === 'image') {
        ext = guessMimeFromUrl(m.url).split('/')[1] || 'png';
      } else if (m.name) {
        ext = m.name.split('.').pop() || 'bin';
      } else if (m.type === 'voice') {
        ext = 'silk';
      } else if (m.type === 'video') {
        ext = 'mp4';
      }
      const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
      const filepath = path.join(cacheDir, filename);
      fs.writeFileSync(filepath, buf);
      saved.push({ type: m.type, path: filepath, name: m.name || filename, size: buf.length });
      logger?.info(`[OpenClaw] 文件已保存: ${filepath} (${(buf.length/1024).toFixed(0)}KB)`);
    } catch (e) {
      logger?.warn(`[OpenClaw] 下载文件失败: ${e.message}`);
      // 回退为 URL
      saved.push({ type: m.type, path: null, url: m.url, name: m.name });
    }
  }

  // 清理 1 小时前的旧文件
  try {
    const cutoff = Date.now() - 3600000;
    for (const f of fs.readdirSync(cacheDir)) {
      const fp = path.join(cacheDir, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
    }
  } catch (_) {}

  return saved;
}

// 从 agent 回复中提取图片 URL（MEDIA:xxx 或 ![alt](url)）
function extractImagesFromReply(text) {
  const images = [];
  // MEDIA: lines
  const mediaRegex = /^MEDIA:\s*(.+)$/gm;
  let match;
  while ((match = mediaRegex.exec(text)) !== null) {
    const url = match[1].trim();
    if (url.startsWith('http')) images.push(url);
  }
  // Markdown images
  const mdRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
  while ((match = mdRegex.exec(text)) !== null) {
    const url = match[1].trim();
    if (url.startsWith('http')) images.push(url);
  }
  // Remove matched patterns from text
  let cleanText = text
    .replace(/^MEDIA:\s*.+$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { images, cleanText };
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
