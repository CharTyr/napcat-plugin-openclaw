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
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { GatewayClient } from './gateway-client';
import { DEFAULT_CONFIG, buildConfigSchema } from './config';
import type { PluginConfig, ExtractedMedia, ChatEventPayload, ContentBlock } from './types';

const execAsync = promisify(exec);

// ========== State ==========
let logger: any = null;
let configPath: string | null = null;
let botUserId: string | number | null = null;
let gatewayClient: GatewayClient | null = null;
let currentConfig: PluginConfig = { ...DEFAULT_CONFIG };

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
  }
  return gatewayClient;
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

function extractTextFromPayload(message: any): string {
  if (typeof message === 'string') return message;
  if (!message) return '';

  const content = message.content;
  if (!content) return message.text ?? '';

  const blocks: any[] = Array.isArray(content) ? content : [content];
  let text = '';
  for (const b of blocks) {
    if (typeof b === 'string') text += b;
    else if (b?.text) text += b.text;
  }
  return text;
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

// ========== Lifecycle ==========

export let plugin_config_ui: any[] = [];

export const plugin_init = async (ctx: any): Promise<void> => {
  logger = ctx.logger;
  configPath = ctx.configPath;
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
    const userWhitelist = currentConfig.behavior.userWhitelist;
    if (userWhitelist.length > 0) {
      if (!userWhitelist.some((id) => Number(id) === Number(userId))) return;
    }

    let shouldHandle = false;

    if (messageType === 'private') {
      if (!currentConfig.behavior.privateChat) return;
      shouldHandle = true;
    } else if (messageType === 'group') {
      if (!groupId) return;
      const gWhitelist = currentConfig.behavior.groupWhitelist;
      if (gWhitelist.length > 0 && !gWhitelist.some((id) => Number(id) === Number(groupId))) return;
      if (currentConfig.behavior.groupAtOnly) {
        const isAtBot = event.message?.some(
          (seg: any) => seg.type === 'at' && String(seg.data?.qq) === String(botUserId || event.self_id)
        );
        if (!isAtBot) return;
      }
      shouldHandle = true;
    }

    if (!shouldHandle) return;

    const { extractedText, extractedMedia } = extractMessage(event.message || []);
    const text = extractedText;
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

    // Build message
    let openclawMessage = text;
    if (extractedMedia.length > 0) {
      const mediaInfo = extractedMedia.map((m) => `[${m.type}: ${m.url}]`).join('\n');
      openclawMessage = openclawMessage ? `${openclawMessage}\n\n${mediaInfo}` : mediaInfo;
    }

    logger.info(
      `[OpenClaw] ${messageType === 'private' ? '私聊' : `群${groupId}`} ${nickname}(${userId}): ${openclawMessage.slice(0, 80)}`
    );

    if (messageType === 'private') setTypingStatus(ctx, userId, true);

    // Send via Gateway RPC + event listener (non-streaming)
    const sessionKey = getSessionKey(sessionBase);
    const runId = randomUUID();

    try {
      const gw = await getGateway();

      // Listen for chat events — only use final (contains full text)
      const replyPromise = new Promise<string | null>((resolve) => {
        const timeout = setTimeout(() => {
          cleanup();
          resolve(null);
        }, 180000);

        const cleanup = () => {
          clearTimeout(timeout);
          gw.eventHandlers.delete('chat');
        };

        gw.eventHandlers.set('chat', (payload: any) => {
          if (!payload) return;
          logger.info(`[OpenClaw] chat event: state=${payload.state} session=${payload.sessionKey} run=${payload.runId?.slice(0, 8)}`);
          if (payload.sessionKey !== sessionKey) return;

          if (payload.state === 'final') {
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

      // Send message
      const sendResult = await gw.request('chat.send', {
        sessionKey,
        message: openclawMessage,
        idempotencyKey: runId,
      });

      logger.info(`[OpenClaw] chat.send 已接受: runId=${sendResult?.runId}`);

      // Wait for final event
      const reply = await replyPromise;

      if (reply) {
        await sendReply(ctx, messageType, groupId, userId, reply);
      } else {
        logger.info('[OpenClaw] 无回复内容');
      }
    } catch (e: any) {
      logger.error(`[OpenClaw] 发送失败: ${e.message}`);
      if (gatewayClient) {
        gatewayClient.disconnect();
        gatewayClient = null;
      }
      try {
        const escapedMessage = openclawMessage.replace(/'/g, "'\\''");
        const cliPath = currentConfig.openclaw.cliPath;
        const { stdout } = await execAsync(
          `OPENCLAW_TOKEN='${currentConfig.openclaw.token}' ${cliPath} agent --session-id '${sessionKey}' --message '${escapedMessage}' 2>&1`,
          { timeout: 180000, maxBuffer: 1024 * 1024 }
        );
        if (stdout.trim()) {
          await sendReply(ctx, messageType, groupId, userId, stdout.trim());
        }
      } catch (e2: any) {
        await sendReply(ctx, messageType, groupId, userId, `处理出错: ${(e as Error).message?.slice(0, 100)}`);
      }
    }
  } catch (outerErr: any) {
    logger?.error(`[OpenClaw] 未捕获异常: ${outerErr.message}\n${outerErr.stack}`);
  }
};

export const plugin_cleanup = async (): Promise<void> => {
  if (gatewayClient) {
    gatewayClient.disconnect();
    gatewayClient = null;
  }
  logger?.info('[OpenClaw] QQ Channel 插件清理完成');
};

// ========== Config Hooks ==========

export const plugin_get_config = async () => currentConfig;

export const plugin_set_config = async (ctx: any, config: any): Promise<void> => {
  currentConfig = config;
  if (gatewayClient) {
    gatewayClient.disconnect();
    gatewayClient = null;
  }
  if (ctx?.configPath) {
    try {
      const dir = path.dirname(ctx.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ctx.configPath, JSON.stringify(config, null, 2), 'utf-8');
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
