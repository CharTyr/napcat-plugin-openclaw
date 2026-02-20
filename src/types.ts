export interface PluginConfig {
  openclaw: {
    token: string;
    gatewayUrl: string;
    cliPath: string;
    deviceIdentity?: {
      id: string;
      publicKeyPem: string;
      privateKeyPem: string;
    };
  };
  behavior: {
    privateChat: boolean;
    groupAtOnly: boolean;
    userWhitelist: number[];
    groupWhitelist: number[];
    debounceMs: number;
    groupSessionMode: 'user' | 'shared';
  };
}

export interface ExtractedMedia {
  type: 'image' | 'file' | 'voice' | 'video';
  url?: string;
  file_id?: string;
  name?: string;
}

export interface SavedMedia {
  type: string;
  path: string | null;
  url?: string;
  name?: string;
  size?: number;
}

export interface ExtractedMessage {
  extractedText: string;
  extractedMedia: ExtractedMedia[];
}

export interface ChatEventPayload {
  sessionKey: string;
  runId: string;
  state: 'delta' | 'final' | 'aborted' | 'error';
  message?: string | MessageContent;
  errorMessage?: string;
}

export interface MessageContent {
  role?: string;
  content?: ContentBlock[] | ContentBlock;
  text?: string;
  stopReason?: string;
}

export interface ContentBlock {
  type?: string;
  text?: string;
}

export interface DebounceResult {
  text: string;
  media: ExtractedMedia[];
}
