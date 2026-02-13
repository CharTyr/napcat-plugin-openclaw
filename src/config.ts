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

export function buildConfigSchema(): any[] {
  return [
    // --- OpenClaw 连接配置 ---
    {
      key: 'openclaw.token',
      label: 'OpenClaw 认证 Token',
      type: 'string',
      default: '',
      description: 'OpenClaw Gateway 认证 Token（必填）',
      placeholder: '在 OpenClaw 配置中获取',
    },
    {
      key: 'openclaw.gatewayUrl',
      label: 'Gateway WebSocket 地址',
      type: 'string',
      default: 'ws://127.0.0.1:18789',
      description: 'OpenClaw Gateway WebSocket 地址',
      placeholder: 'ws://127.0.0.1:18789',
    },
    {
      key: 'openclaw.cliPath',
      label: 'OpenClaw CLI 路径',
      type: 'string',
      default: '/root/.nvm/versions/node/v22.22.0/bin/openclaw',
      description: 'openclaw 命令的完整路径（CLI 回退模式使用）',
      placeholder: 'which openclaw 查看路径',
    },
    // --- 行为配置 ---
    {
      key: 'behavior.privateChat',
      label: '接收私聊消息',
      type: 'boolean',
      default: true,
      description: '是否接收并处理私聊消息',
    },
    {
      key: 'behavior.groupAtOnly',
      label: '群聊仅 @ 触发',
      type: 'boolean',
      default: true,
      description: '群聊中仅 @bot 时才触发回复',
    },
    {
      key: 'behavior.userWhitelist',
      label: '用户白名单',
      type: 'text',
      default: '',
      description: '允许的用户 QQ 号，每行一个，留空表示允许所有',
      placeholder: '123456789\n987654321',
    },
    {
      key: 'behavior.groupWhitelist',
      label: '群白名单',
      type: 'text',
      default: '',
      description: '允许的群号，每行一个，留空表示允许所有',
      placeholder: '123456789\n987654321',
    },
    {
      key: 'behavior.debounceMs',
      label: '消息防抖时长（毫秒）',
      type: 'number',
      default: 2000,
      description: '快速连发的消息自动合并的时间窗口',
    },
    {
      key: 'behavior.groupSessionMode',
      label: '群聊 Session 模式',
      type: 'select',
      default: 'user',
      options: [
        { label: '每人独立', value: 'user' },
        { label: '群共享', value: 'shared' },
      ],
      description: 'user: 每个群成员独立对话上下文；shared: 整个群共享上下文',
    },
  ];
}
