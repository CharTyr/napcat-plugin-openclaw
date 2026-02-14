import type { PluginConfig } from './types';
import type { PluginConfigSchema } from 'napcat-types';

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

export function buildConfigSchema(): PluginConfigSchema {
  return [
    { key: '_header_openclaw', type: 'html', label: '<h3>OpenClaw 连接</h3>' },
    {
      key: 'openclaw.token',
      type: 'string',
      label: 'Token',
      description: 'OpenClaw 服务端令牌',
      default: DEFAULT_CONFIG.openclaw.token,
      placeholder: '请输入 OpenClaw Token',
    },
    {
      key: 'openclaw.gatewayUrl',
      type: 'string',
      label: '网关地址',
      description: 'OpenClaw WebSocket 网关地址',
      default: DEFAULT_CONFIG.openclaw.gatewayUrl,
    },
    {
      key: 'openclaw.cliPath',
      type: 'string',
      label: 'CLI 路径',
      description: 'openclaw 可执行文件路径',
      default: DEFAULT_CONFIG.openclaw.cliPath,
    },
    { key: '_header_behavior', type: 'html', label: '<h3>行为设置</h3>' },
    {
      key: 'behavior.privateChat',
      type: 'boolean',
      label: '私聊启用',
      description: '是否响应私聊消息',
      default: DEFAULT_CONFIG.behavior.privateChat,
    },
    {
      key: 'behavior.groupAtOnly',
      type: 'boolean',
      label: '群聊仅 @',
      description: '群聊中是否仅响应 @ 消息',
      default: DEFAULT_CONFIG.behavior.groupAtOnly,
    },
    {
      key: 'behavior.userWhitelist',
      type: 'string',
      label: '用户白名单',
      description: '允许使用的 QQ 号，多个用英文逗号分隔，留空表示不限制',
      default: '',
    },
    {
      key: 'behavior.groupWhitelist',
      type: 'string',
      label: '群白名单',
      description: '允许使用的群号，多个用英文逗号分隔，留空表示不限制',
      default: '',
    },
    {
      key: 'behavior.debounceMs',
      type: 'number',
      label: '防抖时间 (ms)',
      description: '连续消息的防抖间隔（毫秒）',
      default: DEFAULT_CONFIG.behavior.debounceMs,
    },
    {
      key: 'behavior.groupSessionMode',
      type: 'select',
      label: '群会话模式',
      description: '群聊中的会话隔离方式',
      default: DEFAULT_CONFIG.behavior.groupSessionMode,
      options: [
        { label: '独立会话 (每人独立)', value: 'user' },
        { label: '共享会话 (群共享)', value: 'shared' },
      ],
    },
  ];
}
