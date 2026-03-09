/**
 * NapCat Plugin: OpenClaw AI Channel
 *
 * 通过 OpenClaw Gateway 的 WebSocket RPC 协议（chat.send）将 QQ 变为 AI 助手通道。
 * 所有斜杠命令由 Gateway 统一处理，与 TUI/Telegram 体验一致。
 *
 * @author CharTyr
 * @license MIT
 */

import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import dns from 'dns/promises';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import { GatewayClient } from './gateway-client';
import { DEFAULT_CONFIG, buildConfigSchema } from './config';
import type { PluginConfig, ExtractedMedia, ChatEventPayload, ContentBlock, SavedMedia, DebounceResult } from './types';

const execFileAsync = promisify(execFile);

// ========== State ==========
let logger: any = null;
let configPath: string | null = null;
let botUserId: string | number | null = null;
let gatewayClient: GatewayClient | null = null;
let currentConfig: PluginConfig = { ...DEFAULT_CONFIG };
let lastCtx: any = null;
let pluginDir = '/tmp';
let pushListenerAttached = false;

const debounceBuffers = new Map<
  string,
  {
    messages: string[];
    media: ExtractedMedia[];
    timer: ReturnType<typeof setTimeout>;
    resolve: (value: DebounceResult | null) => void;
  }
>();

// ========== Local Commands ==========

function cmdHelp(): string {
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
    '更多: /commands',
  ].join('\n');
}

function cmdWhoami(
  sessionBase: string,
  userId: number | string,
  nickname: string,
  messageType: string,
  groupId?: number | string
): string {
  const epoch = sessionEpochs.get(sessionBase) || 0;
  const sessionKey = epoch > 0 ? `${sessionBase}-${epoch}` : sessionBase;
  return [
    `👤 ${nickname}`,
    `QQ: ${userId}`,
    `类型: ${messageType === 'private' ? '私聊' : `群聊 (${groupId})`}`,
    `Session: ${sessionKey}`,
  ].join('\n');
}

const LOCAL_COMMANDS: Record<string, (...args: any[]) => string> = {
  '/help': cmdHelp,
  '/whoami': cmdWhoami,
};

// ========== Session Management ==========
const sessionEpochs = new Map<string, number>();

function getSessionBase(messageType: string, userId: number | string, groupId?: number | string): string {
  if (messageType === 'private') return `qq-${userId}`;
  if (currentConfig.behavior.groupSessionMode === 'shared') return `qq-g${groupId}`;
  return `qq-g${groupId}-${userId}`;
}

function getSessionKey(sessionBase: string): string {
  const epoch = sessionEpochs.get(sessionBase) || 0;
  return epoch > 0 ? `${sessionBase}-${epoch}` : sessionBase;
}

// ========== Gateway ==========

async function getGateway(): Promise<GatewayClient> {
  if (!gatewayClient) {
    gatewayClient = new GatewayClient(
      currentConfig.openclaw.gatewayUrl,
      currentConfig.openclaw.token,
      logger
    );
  }
  if (!gatewayClient.connected) {
    await gatewayClient.connect();
    if (!pushListenerAttached) {
      setupAgentPushListener(gatewayClient);
      pushListenerAttached = true;
    }
  }
  return gatewayClient;
}

function debounceMessage(
  sessionBase: string,
  text: string,
  media: ExtractedMedia[],
  debounceMs: number
): Promise<DebounceResult | null> {
  return new Promise((resolve) => {
    let buf = debounceBuffers.get(sessionBase);
    if (buf) {
      if (text) buf.messages.push(text);
      if (media.length > 0) buf.media.push(...media);
      clearTimeout(buf.timer);
      const prevResolve = buf.resolve;
      buf.resolve = resolve;
      prevResolve(null);
    } else {
      buf = {
        messages: text ? [text] : [],
        media: [...media],
        resolve,
        timer: setTimeout(() => undefined, 0),
      };
      debounceBuffers.set(sessionBase, buf);
    }

    buf.timer = setTimeout(() => {
      debounceBuffers.delete(sessionBase);
      buf!.resolve({
        text: buf!.messages.join('\n'),
        media: buf!.media,
      });
    }, debounceMs);
  });
}

// ========== Message Extraction ==========

function extractMessage(segments: any[]): { extractedText: string; extractedMedia: ExtractedMedia[] } {
  const textParts: string[] = [];
  const media: ExtractedMedia[] = [];

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
    }
  }

  return { extractedText: textParts.join(' '), extractedMedia: media };
}

// ========== Text Extraction from Chat Event ==========

function extractTextFromContent(content: any): string {
  if (typeof content === 'string') return content;
  if (!content) return '';

  if (Array.isArray(content)) {
    return content
      .map((item) => extractTextFromContent(item))
      .filter(Boolean)
      .join('\n');
  }

  if (typeof content !== 'object') return '';

  if (typeof content.text === 'string') return content.text;
  if (typeof content.output_text === 'string') return content.output_text;
  if (typeof content.input_text === 'string') return content.input_text;
  if (content.content) return extractTextFromContent(content.content);
  return '';
}

function extractTextFromPayload(message: any): string {
  if (typeof message === 'string') return message;
  if (!message) return '';

  const contentText = extractTextFromContent(message.content);
  if (contentText.trim()) return contentText;
  if (typeof message.text === 'string') return message.text;
  return '';
}

function extractContentText(message: any): string {
  return extractTextFromPayload(message);
}

// ========== Typing Status ==========

async function setTypingStatus(ctx: any, userId: number | string, typing: boolean): Promise<void> {
  try {
    await ctx.actions.call(
      'set_input_status',
      { user_id: String(userId), event_type: typing ? 1 : 0 },
      ctx.adapterName,
      ctx.pluginManager?.config
    );
  } catch (e: any) {
    logger?.warn(`[OpenClaw] 设置输入状态失败: ${e.message}`);
  }
}

// ========== Message Sending ==========

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeMessageTimestampMs(message: any): number | null {
  if (!message) return null;
  if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    return message.timestamp;
  }
  if (typeof message.timestamp === 'string') {
    const parsed = Date.parse(message.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pickLatestAssistantText(messages: any[], minTimestampMs: number): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;

    const role = typeof msg.role === 'string' ? msg.role.toLowerCase() : '';
    if (role !== 'assistant') continue;

    const text = extractContentText(msg).trim();
    if (!text) continue;

    const ts = normalizeMessageTimestampMs(msg);
    if (ts !== null && ts + 1000 < minTimestampMs) continue;

    return text;
  }
  return null;
}

async function resolveReplyFromHistory(
  gw: GatewayClient,
  sessionKey: string,
  minTimestampMs: number,
  options?: {
    maxAttempts?: number;
    intervalMs?: number;
    shouldStop?: () => boolean;
  }
): Promise<string | null> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 6);
  const intervalMs = Math.max(100, options?.intervalMs ?? 350);
  for (let i = 0; i < maxAttempts; i++) {
    if (options?.shouldStop?.()) return null;
    try {
      const history = await gw.request('chat.history', { sessionKey, limit: 100 });
      const messages = Array.isArray(history?.messages) ? history.messages : [];
      const text = pickLatestAssistantText(messages, minTimestampMs);
      if (text) return text;
    } catch (e: any) {
      logger?.warn(`[OpenClaw] 回查 chat.history 失败: ${e.message}`);
      return null;
    }

    if (i + 1 < maxAttempts) {
      await sleep(intervalMs);
    }
  }
  return null;
}

function isRecoverableGatewayError(errorMessage: string): boolean {
  const normalized = errorMessage.trim().toLowerCase();
  if (!normalized) return false;
  return /(terminated|abort|cancel|killed|interrupt|retry|timeout|in[_ -]?flight)/i.test(normalized);
}

async function sendReply(ctx: any, messageType: string, groupId: any, userId: any, text: string): Promise<void> {
  const action = messageType === 'group' ? 'send_group_msg' : 'send_private_msg';
  const idKey = messageType === 'group' ? 'group_id' : 'user_id';
  const idVal = String(messageType === 'group' ? groupId : userId);

  const maxLen = 3000;
  if (text.length <= maxLen) {
    await ctx.actions.call(action, { [idKey]: idVal, message: text }, ctx.adapterName, ctx.pluginManager?.config);
  } else {
    const total = Math.ceil(text.length / maxLen);
    for (let i = 0; i < text.length; i += maxLen) {
      const idx = Math.floor(i / maxLen) + 1;
      const prefix = total > 1 ? `[${idx}/${total}]\n` : '';
      await ctx.actions.call(
        action,
        { [idKey]: idVal, message: prefix + text.slice(i, i + maxLen) },
        ctx.adapterName,
        ctx.pluginManager?.config
      );
      if (i + maxLen < text.length) await sleep(1000);
    }
  }
}

async function sendImageMsg(
  ctx: any,
  messageType: string,
  groupId: number | string | null,
  userId: number | string | null,
  imageUrl: string
): Promise<void> {
  const message = [{ type: 'image', data: { url: imageUrl } }];
  if (messageType === 'group') {
    await ctx.actions.call(
      'send_group_msg',
      { group_id: String(groupId), message },
      ctx.adapterName,
      ctx.pluginManager?.config
    );
    return;
  }
  await ctx.actions.call(
    'send_private_msg',
    { user_id: String(userId), message },
    ctx.adapterName,
    ctx.pluginManager?.config
  );
}

async function sendGroupMsg(ctx: any, groupId: string | number, text: string): Promise<void> {
  await ctx.actions.call(
    'send_group_msg',
    { group_id: String(groupId), message: text },
    ctx.adapterName,
    ctx.pluginManager?.config
  );
}

async function sendPrivateMsg(ctx: any, userId: string | number, text: string): Promise<void> {
  await ctx.actions.call(
    'send_private_msg',
    { user_id: String(userId), message: text },
    ctx.adapterName,
    ctx.pluginManager?.config
  );
}

function isPrivateIp(host: string): boolean {
  if (!host) return true;
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === 'ip6-localhost') return true;

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    if (normalized.startsWith('127.')) return true;
    if (normalized.startsWith('10.')) return true;
    if (normalized.startsWith('192.168.')) return true;
    if (normalized.startsWith('169.254.')) return true;
    const parts = normalized.split('.').map(Number);
    if (parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    return false;
  }
  if (ipVersion === 6) {
    if (normalized === '::1') return true;
    return normalized.startsWith('fc') || normalized.startsWith('fd');
  }
  return false;
}

async function assertSafeRemoteUrl(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported protocol: ${parsed.protocol}`);
  }
  if (!parsed.hostname) {
    throw new Error('invalid hostname');
  }
  if (isPrivateIp(parsed.hostname)) {
    throw new Error('private network address is not allowed');
  }
  const records = await dns.lookup(parsed.hostname, { all: true });
  if (!records.length) {
    throw new Error('hostname resolution failed');
  }
  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new Error('resolved private network address is not allowed');
    }
  }
  return parsed;
}

async function downloadToBuffer(url: string, maxBytes = 5 * 1024 * 1024, redirectCount = 0): Promise<Buffer> {
  if (redirectCount > 5) {
    throw new Error('too many redirects');
  }
  const parsed = await assertSafeRemoteUrl(url);
  return new Promise((resolve, reject) => {
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(parsed.toString(), { timeout: 10000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location, parsed).toString();
        res.resume();
        void downloadToBuffer(nextUrl, maxBytes, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
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
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

function guessMimeFromUrl(url?: string): string {
  const ext = (url || '').split('?')[0].split('.').pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
  };
  return mimeMap[ext || ''] || 'image/png';
}

async function saveMediaToCache(mediaList: ExtractedMedia[], ctx: any): Promise<SavedMedia[]> {
  const cacheDir = path.join(pluginDir || '/tmp', 'cache', 'media');
  await fs.promises.mkdir(cacheDir, { recursive: true });

  const saved: SavedMedia[] = [];
  for (const m of mediaList) {
    try {
      let buf: Buffer | null = null;
      if (m.url) {
        buf = await downloadToBuffer(m.url, 10 * 1024 * 1024);
      } else if (m.file_id && ctx) {
        try {
          const fileInfo = await ctx.actions.call(
            'get_file',
            { file_id: m.file_id },
            ctx.adapterName,
            ctx.pluginManager?.config
          );
          if (fileInfo?.file) {
            try {
              await fs.promises.access(fileInfo.file);
              buf = await fs.promises.readFile(fileInfo.file);
            } catch {
              if (fileInfo.url) buf = await downloadToBuffer(fileInfo.url, 10 * 1024 * 1024);
              else if (fileInfo.base64) buf = Buffer.from(fileInfo.base64, 'base64');
            }
          }
        } catch (e: any) {
          logger?.warn(`[OpenClaw] get_file 失败: ${e.message}`);
        }
      }

      if (!buf) {
        saved.push({ type: m.type, path: null, url: m.url, name: m.name });
        continue;
      }
      let ext = 'bin';
      if (m.type === 'image') ext = guessMimeFromUrl(m.url).split('/')[1] || 'png';
      else if (m.name) ext = m.name.split('.').pop() || 'bin';
      else if (m.type === 'voice') ext = 'silk';
      else if (m.type === 'video') ext = 'mp4';

      const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
      const filePath = path.join(cacheDir, filename);
      await fs.promises.writeFile(filePath, buf);
      saved.push({ type: m.type, path: filePath, name: m.name || filename, size: buf.length });
    } catch (e: any) {
      logger?.warn(`[OpenClaw] 下载文件失败: ${e.message}`);
      saved.push({ type: m.type, path: null, url: m.url, name: m.name });
    }
  }

  try {
    const cutoff = Date.now() - 3600000;
    const files = await fs.promises.readdir(cacheDir);
    for (const name of files) {
      const fullPath = path.join(cacheDir, name);
      const stat = await fs.promises.stat(fullPath);
      if (stat.mtimeMs < cutoff) await fs.promises.unlink(fullPath);
    }
  } catch {
    // ignore cleanup errors
  }

  return saved;
}

function extractImagesFromReply(text: string): { images: string[]; cleanText: string } {
  const images: string[] = [];
  const mediaRegex = /^MEDIA:\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = mediaRegex.exec(text)) !== null) {
    const url = match[1].trim();
    if (url.startsWith('http')) images.push(url);
  }
  const mdRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
  while ((match = mdRegex.exec(text)) !== null) {
    const url = match[1].trim();
    if (url.startsWith('http')) images.push(url);
  }
  const cleanText = text
    .replace(/^MEDIA:\s*.+$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .trim();
  return { images: Array.from(new Set(images)), cleanText };
}

function setupAgentPushListener(gw: GatewayClient): void {
  gw.eventHandlers.set('chat', (payload: ChatEventPayload) => {
    if (!payload || payload.state !== 'final' || !payload.sessionKey) return;
    if (!payload.sessionKey.startsWith('qq-')) return;
    if (payload.runId && gw.chatWaiters.has(payload.runId)) return;
    if (!lastCtx) return;

    const text = extractContentText(payload.message).trim();
    if (!text) return;
    logger?.info(`[OpenClaw] Agent 主动推送: ${payload.sessionKey} -> ${text.slice(0, 50)}`);

    const privateMatch = payload.sessionKey.match(/^qq-(\d+)(?:-\d+)?$/);
    if (privateMatch && !payload.sessionKey.includes('-g')) {
      const { images, cleanText } = extractImagesFromReply(text);
      if (cleanText) void sendPrivateMsg(lastCtx, privateMatch[1], cleanText);
      for (const img of images) void sendImageMsg(lastCtx, 'private', null, privateMatch[1], img);
      return;
    }

    const groupMatch = payload.sessionKey.match(/^qq-g(\d+)/);
    if (groupMatch) {
      const { images, cleanText } = extractImagesFromReply(text);
      if (cleanText) void sendGroupMsg(lastCtx, groupMatch[1], cleanText);
      for (const img of images) void sendImageMsg(lastCtx, 'group', groupMatch[1], null, img);
    }
  });
}

// ========== Lifecycle ==========

export let plugin_config_ui: any[] = [];

export const plugin_init = async (ctx: any): Promise<void> => {
  logger = ctx.logger;
  lastCtx = ctx;
  configPath = ctx.configPath;
  // import.meta.url may become a data: URI after bundling (Vite asset inlining),
  // which produces an absurdly long pathname and triggers ENAMETOOLONG on mkdir.
  try {
    const metaUrl = import.meta.url;
    if (metaUrl && metaUrl.startsWith('file:')) {
      pluginDir = new URL('.', metaUrl).pathname;
    } else {
      pluginDir = '/tmp';
    }
  } catch {
    pluginDir = '/tmp';
  }
  logger.info('[OpenClaw] QQ Channel 插件初始化中...');

  // Load saved config
  try {
    if (configPath && fs.existsSync(configPath)) {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      currentConfig = deepMerge(currentConfig, saved);
      logger.info('[OpenClaw] 已加载保存的配置');
    }
  } catch (e: any) {
    logger.warn('[OpenClaw] 加载配置失败: ' + e.message);
  }

  plugin_config_ui = buildConfigSchema();

  // Pre-connect gateway
  try {
    await getGateway();
    logger.info('[OpenClaw] Gateway 连接就绪');
  } catch (e: any) {
    logger.error(`[OpenClaw] Gateway 预连接失败: ${e.message}（将在首次消息时重试）`);
  }

  logger.info(`[OpenClaw] 网关: ${currentConfig.openclaw.gatewayUrl}`);
  logger.info('[OpenClaw] 模式: 私聊全透传 + 群聊@触发 + 命令透传');
  logger.info('[OpenClaw] QQ Channel 插件初始化完成');
};

export const plugin_onmessage = async (ctx: any, event: any): Promise<void> => {
  let typingStatusOn = false;
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

    // User whitelist
    const behavior = currentConfig.behavior || {};
    const userWhitelist = behavior.userWhitelist || [];
    if (userWhitelist.length > 0) {
      if (!userWhitelist.some((id) => Number(id) === Number(userId))) return;
    }

    let shouldHandle = false;

    if (messageType === 'private') {
      if (behavior.privateChat === false) return;
      shouldHandle = true;
    } else if (messageType === 'group') {
      if (!groupId) return;
      const gWhitelist = behavior.groupWhitelist || [];
      if (gWhitelist.length > 0 && !gWhitelist.some((id) => Number(id) === Number(groupId))) return;
      if (behavior.groupAtOnly !== false) {
        const isAtBot = event.message?.some(
          (seg: any) => seg.type === 'at' && String(seg.data?.qq) === String(botUserId || event.self_id)
        );
        if (!isAtBot) return;
      }
      shouldHandle = true;
    }

    if (!shouldHandle) return;

    lastCtx = ctx;
    let { extractedText, extractedMedia } = extractMessage(event.message || []);
    let text = extractedText;
    if (!text && extractedMedia.length === 0) return;

    const sessionBase = getSessionBase(messageType, userId, groupId);

    // Local commands
    if (text?.startsWith('/')) {
      const spaceIdx = text.indexOf(' ');
      const cmd = (spaceIdx > 0 ? text.slice(0, spaceIdx) : text).toLowerCase();
      const args = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : '';

      if (LOCAL_COMMANDS[cmd]) {
        logger.info(`[OpenClaw] 本地命令: ${cmd} from ${nickname}(${userId})`);
        const result = LOCAL_COMMANDS[cmd](sessionBase, userId, nickname, messageType, groupId, args);
        if (result) {
          await sendReply(ctx, messageType, groupId, userId, result);
          return;
        }
      }
    }

    const debounceMsRaw = currentConfig.behavior.debounceMs;
    const debounceMs = Number.isFinite(debounceMsRaw) ? debounceMsRaw : 2000;
    if (debounceMs > 0 && !(text && text.startsWith('/'))) {
      const merged = await debounceMessage(sessionBase, text || '', extractedMedia, debounceMs);
      if (!merged) return;
      extractedText = merged.text;
      extractedMedia = merged.media;
      text = extractedText;
      if (!text && extractedMedia.length === 0) return;
    }

    // Build message
    let openclawMessage = text || '';
    if (extractedMedia.length > 0) {
      const savedMedia = await saveMediaToCache(extractedMedia, ctx);
      if (savedMedia.length > 0) {
        const mediaInfo = savedMedia.map((m) => {
          if (m.path) {
            if (m.type === 'image') return `[用户发送了图片: ${m.path}]`;
            if (m.type === 'file') return `[用户发送了文件「${m.name}」: ${m.path}]`;
            if (m.type === 'voice') return `[用户发送了语音: ${m.path}]`;
            if (m.type === 'video') return `[用户发送了视频: ${m.path}]`;
            return `[用户发送了${m.type}: ${m.path}]`;
          }
          return `[用户发送了${m.type}: ${m.url}]`;
        }).join('\n');
        openclawMessage = openclawMessage ? `${openclawMessage}\n\n${mediaInfo}` : mediaInfo;
      }
    }

    logger.info(
      `[OpenClaw] ${messageType === 'private' ? '私聊' : `群${groupId}`} ${nickname}(${userId}): ${openclawMessage.slice(0, 50)}`
    );

    if (messageType === 'private') {
      typingStatusOn = true;
      await setTypingStatus(ctx, userId, true);
    }

    // Send via Gateway RPC + event listener (non-streaming)
    const sessionKey = getSessionKey(sessionBase);
    const runId = randomUUID();
    const runStartedAtMs = Date.now();

    let gw: GatewayClient | null = null;
    let waitRunId = runId;
    try {
      gw = await getGateway();
      const gwClient = gw;

      // 按 runId 监听 chat 事件，避免多个会话并发时全局 handler 被覆盖
      const replyPromise = new Promise<string | null>((resolve) => {
        let settled = false;
        let recovering = false;
        let latestSessionKey = sessionKey;

        const safeResolve = (value: string | null) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const recoverFromHistory = async (
          reason: string,
          fallback: string | null,
          maxAttempts = 40,
          intervalMs = 500
        ) => {
          if (settled || recovering) return;
          recovering = true;
          try {
            const historyText = await resolveReplyFromHistory(gwClient, latestSessionKey, runStartedAtMs, {
              maxAttempts,
              intervalMs,
              shouldStop: () => settled,
            });
            if (settled) return;
            if (historyText) {
              logger.info(`[OpenClaw] ${reason}，已通过 chat.history 回填回复`);
              safeResolve(historyText);
              return;
            }
            safeResolve(fallback);
          } finally {
            recovering = false;
          }
        };

        const timeout = setTimeout(() => {
          logger.warn('[OpenClaw] 等待 final 超时，尝试通过 chat.history 补拉回复');
          void recoverFromHistory('等待 final 超时', null, 12, 500);
        }, 180000);

        const cleanup = () => {
          clearTimeout(timeout);
          gwClient.chatWaiters.delete(waitRunId);
        };

        gwClient.chatWaiters.set(waitRunId, { handler: (payload: any) => {
          if (settled) return;
          if (!payload) return;
          if (typeof payload.sessionKey === 'string' && payload.sessionKey.trim()) {
            latestSessionKey = payload.sessionKey.trim();
          }
          logger.info(`[OpenClaw] chat event: state=${payload.state} session=${payload.sessionKey} run=${payload.runId?.slice(0, 8)}`);

          if (payload.state === 'final') {
            const directText = extractContentText(payload.message).trim();
            if (directText) {
              safeResolve(directText);
              return;
            }
            void recoverFromHistory('final 帧无文本', null, 20, 400);
            return;
          }

          if (payload.state === 'aborted') {
            logger.warn('[OpenClaw] 收到 aborted 事件，等待后续重试结果');
            void recoverFromHistory(
              '收到 aborted 事件',
              '⚠️ 本次运行被中断，未拿到最终回复，请稍后重试。',
              45,
              500
            );
            return;
          }

          if (payload.state === 'error') {
            const errorMessage = String(payload.errorMessage || '处理出错');
            if (isRecoverableGatewayError(errorMessage)) {
              logger.warn(`[OpenClaw] 收到可恢复错误: ${errorMessage}，等待后续重试结果`);
              void recoverFromHistory(
                `收到 error(${errorMessage})`,
                '⚠️ 本次运行被中断，未拿到最终回复，请稍后重试。',
                45,
                500
              );
            } else {
              safeResolve(`❌ ${errorMessage}`);
            }
            return;
          }
        }});
      });

      // Send message
      const sendResult = await gwClient.request('chat.send', {
        sessionKey,
        message: openclawMessage,
        idempotencyKey: runId,
      });

      logger.info(`[OpenClaw] chat.send 已接受: runId=${sendResult?.runId}`);
      const actualRunId = typeof sendResult?.runId === 'string' && sendResult.runId ? sendResult.runId : runId;
      if (actualRunId !== waitRunId) {
        const waiter = gwClient.chatWaiters.get(waitRunId);
        if (waiter) {
          gwClient.chatWaiters.delete(waitRunId);
          waitRunId = actualRunId;
          gwClient.chatWaiters.set(waitRunId, waiter);
        }
        logger.warn(
          `[OpenClaw] runId 重映射: local=${runId.slice(0, 8)} server=${actualRunId.slice(0, 8)}`
        );
      }

      // Wait for final event
      const reply = await replyPromise;

      if (reply) {
        const { images, cleanText } = extractImagesFromReply(reply);
        if (cleanText) {
          await sendReply(ctx, messageType, groupId, userId, cleanText);
        }
        for (const imageUrl of images) {
          try {
            await sendImageMsg(ctx, messageType, groupId ?? null, userId ?? null, imageUrl);
          } catch (e: any) {
            logger?.warn(`[OpenClaw] 发送图片失败: ${e.message}`);
          }
        }
      } else {
        logger.warn('[OpenClaw] 无回复内容，返回兜底提示');
        await sendReply(ctx, messageType, groupId, userId, '⚠️ 模型未返回内容，请稍后重试。');
      }
    } catch (e: any) {
      if (gw && waitRunId) {
        gw.chatWaiters.delete(waitRunId);
      }
      logger.error(`[OpenClaw] 发送失败: ${e.message}`);
      if (gatewayClient) {
        gatewayClient.disconnect();
        gatewayClient = null;
        pushListenerAttached = false;
      }
      try {
        const cliPath = currentConfig.openclaw.cliPath || '/root/.nvm/versions/node/v22.22.0/bin/openclaw';
        const { stdout, stderr } = await execFileAsync(
          cliPath,
          ['agent', '--session-id', sessionKey, '--message', openclawMessage],
          {
            env: { ...process.env, OPENCLAW_TOKEN: currentConfig.openclaw.token || '' },
            timeout: 180000,
            maxBuffer: 1024 * 1024,
          }
        );
        const fallbackOutput = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (fallbackOutput) {
          await sendReply(ctx, messageType, groupId, userId, fallbackOutput);
        }
      } catch (e2: any) {
        await sendReply(ctx, messageType, groupId, userId, `处理出错: ${(e as Error).message?.slice(0, 100)}`);
      }
    }
  } catch (outerErr: any) {
    logger?.error(`[OpenClaw] 未捕获异常: ${outerErr.message}\n${outerErr.stack}`);
  } finally {
    if (typingStatusOn) {
      await setTypingStatus(ctx, event?.user_id, false);
    }
  }
};

export const plugin_cleanup = async (): Promise<void> => {
  for (const [, entry] of debounceBuffers) {
    clearTimeout(entry.timer);
  }
  debounceBuffers.clear();
  if (gatewayClient) {
    gatewayClient.disconnect();
    gatewayClient = null;
    pushListenerAttached = false;
  }
  pushListenerAttached = false;
  logger?.info('[OpenClaw] QQ Channel 插件清理完成');
};

// ========== Config Hooks ==========

// Flatten nested config to flat keys for WebUI
function flattenConfig(cfg: PluginConfig): Record<string, any> {
  const behavior = cfg.behavior || {};
  return {
    token: cfg.openclaw?.token ?? '',
    gatewayUrl: cfg.openclaw?.gatewayUrl ?? 'ws://127.0.0.1:18789',
    cliPath: cfg.openclaw?.cliPath ?? '',
    privateChat: behavior.privateChat ?? true,
    groupAtOnly: behavior.groupAtOnly ?? true,
    userWhitelist: (behavior.userWhitelist || []).join(','),
    groupWhitelist: (behavior.groupWhitelist || []).join(','),
    debounceMs: behavior.debounceMs ?? 2000,
    groupSessionMode: behavior.groupSessionMode ?? 'user',
  };
}

// Unflatten flat WebUI config back to nested structure
function unflattenConfig(flat: Record<string, any>): PluginConfig {
  const parseDebounceMs = (value: any): number => {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    return 2000;
  };
  const parseNumList = (s: any): number[] => {
    if (Array.isArray(s)) return s.map(Number).filter(Boolean);
    if (typeof s === 'string' && s.trim()) return s.split(',').map((x: string) => Number(x.trim())).filter(Boolean);
    return [];
  };
  return {
    openclaw: {
      token: flat.token ?? '',
      gatewayUrl: flat.gatewayUrl ?? 'ws://127.0.0.1:18789',
      cliPath: flat.cliPath ?? '/root/.nvm/versions/node/v22.22.0/bin/openclaw',
    },
    behavior: {
      privateChat: flat.privateChat !== false,
      groupAtOnly: flat.groupAtOnly !== false,
      userWhitelist: parseNumList(flat.userWhitelist),
      groupWhitelist: parseNumList(flat.groupWhitelist),
      debounceMs: parseDebounceMs(flat.debounceMs),
      groupSessionMode: flat.groupSessionMode === 'shared' ? 'shared' : 'user',
    },
  };
}

export const plugin_get_config = async () => {
  const flat = flattenConfig(currentConfig);
  if (flat.token) {
    const t = String(flat.token);
    flat.token = t.length > 8 ? `${t.slice(0, 4)}****${t.slice(-4)}` : '****';
  }
  return flat;
};

export const plugin_set_config = async (ctx: any, config: any): Promise<void> => {
  const get = (plainKey: string, dottedKey: string): any => {
    if (config?.[plainKey] !== undefined) return config[plainKey];
    return config?.[dottedKey];
  };

  const maybeToken = get('token', 'openclaw.token');
  const maybeGatewayUrl = get('gatewayUrl', 'openclaw.gatewayUrl');
  const maybeCliPath = get('cliPath', 'openclaw.cliPath');
  const maybePrivateChat = get('privateChat', 'behavior.privateChat');
  const maybeGroupAtOnly = get('groupAtOnly', 'behavior.groupAtOnly');
  const maybeUserWhitelist = get('userWhitelist', 'behavior.userWhitelist');
  const maybeGroupWhitelist = get('groupWhitelist', 'behavior.groupWhitelist');
  const maybeDebounceMs = get('debounceMs', 'behavior.debounceMs');
  const maybeGroupSessionMode = get('groupSessionMode', 'behavior.groupSessionMode');

  if (
    maybeToken !== undefined ||
    maybeGatewayUrl !== undefined ||
    maybeCliPath !== undefined ||
    maybePrivateChat !== undefined ||
    maybeGroupAtOnly !== undefined ||
    maybeUserWhitelist !== undefined ||
    maybeGroupWhitelist !== undefined ||
    maybeDebounceMs !== undefined ||
    maybeGroupSessionMode !== undefined
  ) {
    const flatConfig = {
      token: typeof maybeToken === 'string' && maybeToken.includes('****')
        ? currentConfig.openclaw.token
        : (maybeToken ?? currentConfig.openclaw.token),
      gatewayUrl: maybeGatewayUrl ?? currentConfig.openclaw.gatewayUrl,
      cliPath: maybeCliPath ?? currentConfig.openclaw.cliPath,
      privateChat: maybePrivateChat ?? currentConfig.behavior.privateChat,
      groupAtOnly: maybeGroupAtOnly ?? currentConfig.behavior.groupAtOnly,
      userWhitelist: maybeUserWhitelist ?? currentConfig.behavior.userWhitelist.join(','),
      groupWhitelist: maybeGroupWhitelist ?? currentConfig.behavior.groupWhitelist.join(','),
      debounceMs: maybeDebounceMs ?? currentConfig.behavior.debounceMs,
      groupSessionMode: maybeGroupSessionMode ?? currentConfig.behavior.groupSessionMode,
    };
    currentConfig = unflattenConfig(flatConfig);
  } else {
    currentConfig = deepMerge(currentConfig, config);
  }
  if (gatewayClient) {
    gatewayClient.disconnect();
    gatewayClient = null;
  }
  if (ctx?.configPath) {
    try {
      const dir = path.dirname(ctx.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ctx.configPath, JSON.stringify(currentConfig, null, 2), 'utf-8');
    } catch (e: any) {
      logger?.error('[OpenClaw] 保存配置失败: ' + e.message);
    }
  }
};

// ========== Utils ==========

function deepMerge(target: any, source: any): any {
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
