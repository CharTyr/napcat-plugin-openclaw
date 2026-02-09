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
