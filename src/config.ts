import type { NapCatPluginContext, PluginConfigSchema } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { PluginConfig } from './types';

export const DEFAULT_CONFIG: PluginConfig = {
  openclaw: {
    token: '',
    gatewayUrl: 'ws://127.0.0.1:18789',
    cliPath: '/root/.nvm/versions/node/v22.22.0/bin/openclaw',
  },
  behavior: {
    privateChat: true,
    groupAtOnly: true,
    userWhitelist: [],
    groupWhitelist: [],
    debounceMs: 2000,
    groupSessionMode: 'user',
  },
};

/**
 * 构建 WebUI 配置 Schema
 * 使用 ctx.NapCatConfig 构建器确保格式正确
 */
export function buildConfigSchema(ctx: NapCatPluginContext): PluginConfigSchema {
  return ctx.NapCatConfig.combine(
    // --- OpenClaw 连接配置 ---
    ctx.NapCatConfig.text('openclaw.token', 'OpenClaw 认证 Token', '', 'OpenClaw Gateway 认证 Token（必填）'),
    ctx.NapCatConfig.text('openclaw.gatewayUrl', 'Gateway WebSocket 地址', 'ws://127.0.0.1:18789', 'OpenClaw Gateway WebSocket 地址'),
    ctx.NapCatConfig.text('openclaw.cliPath', 'OpenClaw CLI 路径', '/root/.nvm/versions/node/v22.22.0/bin/openclaw', 'openclaw 命令的完整路径（CLI 回退模式使用，可留空）'),

    // --- 行为配置 ---
    ctx.NapCatConfig.boolean('behavior.privateChat', '接收私聊消息', true, '是否接收并处理私聊消息'),
    ctx.NapCatConfig.boolean('behavior.groupAtOnly', '群聊仅 @ 触发', true, '群聊中仅 @bot 时才触发回复'),
    ctx.NapCatConfig.text('behavior.userWhitelist', '用户白名单', '', '允许的用户 QQ 号，每行一个，留空表示允许所有'),
    ctx.NapCatConfig.text('behavior.groupWhitelist', '群白名单', '', '允许的群号，每行一个，留空表示允许所有'),
    ctx.NapCatConfig.number('behavior.debounceMs', '消息防抖时长（毫秒）', 2000, '快速连发的消息自动合并的时间窗口'),
    ctx.NapCatConfig.select('behavior.groupSessionMode', '群聊 Session 模式', [
      { label: '每人独立', value: 'user' },
      { label: '群共享', value: 'shared' },
    ], 'user', 'user: 每个群成员独立对话上下文；shared: 整个群共享上下文')
  );
}
