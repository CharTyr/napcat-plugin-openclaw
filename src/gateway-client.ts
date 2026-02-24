import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as signWithKey,
} from 'crypto';
import { fileURLToPath } from 'url';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

interface ChatWaiter {
  handler: (payload: any) => void;
}

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

interface StoredDeviceIdentity {
  version: 1;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
}

interface DeviceAuthPayloadParams {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce?: string | null;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = createPublicKey(publicKeyPem);
  const spki = key.export({ type: 'spki', format: 'der' }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return createHash('sha256').update(derivePublicKeyRaw(publicKeyPem)).digest('hex');
}

function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function buildDeviceAuthPayload(params: DeviceAuthPayloadParams): string {
  const version = params.nonce ? 'v2' : 'v1';
  const scopes = params.scopes.join(',');
  const token = params.token ?? '';
  const base = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
  ];
  if (version === 'v2') {
    base.push(params.nonce ?? '');
  }
  return base.join('|');
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = createPrivateKey(privateKeyPem);
  const signature = signWithKey(null, Buffer.from(payload, 'utf8'), key);
  return base64UrlEncode(signature);
}

function resolveDeviceIdentityPath(): string {
  const envPath = process.env.OPENCLAW_DEVICE_IDENTITY_PATH?.trim();
  if (envPath) return envPath;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(moduleDir, '.openclaw-device.json');
}

function loadOrCreateDeviceIdentity(filePath: string): DeviceIdentity {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoredDeviceIdentity;
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === 'string' &&
        typeof parsed.publicKeyPem === 'string' &&
        typeof parsed.privateKeyPem === 'string'
      ) {
        const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
        if (derivedId !== parsed.deviceId) {
          const updated: StoredDeviceIdentity = { ...parsed, deviceId: derivedId };
          fs.writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
          try {
            fs.chmodSync(filePath, 0o600);
          } catch {
            // 最佳努力权限收敛
          }
          return {
            deviceId: derivedId,
            publicKeyPem: parsed.publicKeyPem,
            privateKeyPem: parsed.privateKeyPem,
          };
        }
        return {
          deviceId: parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    }
  } catch {
    // 文件损坏时自动重建
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const identity: DeviceIdentity = {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
  };

  ensureDir(filePath);
  const stored: StoredDeviceIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // 最佳努力权限收敛
  }

  return identity;
}

export class GatewayClient {
  private url: string;
  private token: string;
  private deviceIdentityPath: string;
  private deviceIdentity: DeviceIdentity | null = null;
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  public eventHandlers = new Map<string, (payload: any) => void>();
  public chatWaiters = new Map<string, ChatWaiter>();
  private _connected = false;
  private connectPromise: Promise<void> | null = null;
  private connectNonce: string | null = null;
  private logger: any;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPong = 0;
  private _destroyed = false;

  constructor(url: string, token: string, logger?: any) {
    this.url = url;
    this.token = token;
    this.logger = logger;
    this.deviceIdentityPath = resolveDeviceIdentityPath();

    try {
      this.deviceIdentity = loadOrCreateDeviceIdentity(this.deviceIdentityPath);
      this.logger?.info(
        `[OpenClaw] 设备身份已就绪: ${this.deviceIdentity.deviceId.slice(0, 8)}... (${this.deviceIdentityPath})`
      );
    } catch (e: any) {
      this.deviceIdentity = null;
      this.logger?.warn(`[OpenClaw] 设备身份初始化失败，将退化为无 device 握手: ${e?.message || e}`);
    }
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    if (this._connected && this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
          try {
            this.ws.close(4001, 'connect timeout');
          } catch {
            // ignore close errors on timeout path
          }
        }
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
        this.logger?.info('[OpenClaw] WS 已连接，等待 challenge...');
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const frame = JSON.parse(data.toString());
          this.handleFrame(frame, resolve, reject, timeout);
        } catch (e: any) {
          this.logger?.error(`[OpenClaw] 解析帧失败: ${e.message}`);
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        this.logger?.info(`[OpenClaw] WS 关闭: ${code} ${reason}`);
        this._connected = false;
        this.connectPromise = null;
        this.stopHeartbeat();
        for (const [, p] of this.pending) {
          p.reject(new Error(`ws closed: ${code}`));
        }
        this.pending.clear();
        this.scheduleReconnect();
      });

      this.ws.on('error', (err: Error) => {
        this.logger?.error(`[OpenClaw] WS 错误: ${err.message}`);
        clearTimeout(timeout);
        this._connected = false;
        this.connectPromise = null;
        this.stopHeartbeat();
        reject(err);
        this.scheduleReconnect();
      });
    });

    return this.connectPromise;
  }

  private handleFrame(
    frame: any,
    connectResolve: (value: void) => void,
    connectReject: (err: Error) => void,
    connectTimeout: NodeJS.Timeout
  ): void {
    this.lastPong = Date.now();

    // Challenge event
    if (frame.type === 'event' && frame.event === 'connect.challenge') {
      this.connectNonce = frame.payload?.nonce;
      this.logger?.info(`[OpenClaw] 收到 challenge, nonce=${this.connectNonce?.slice(0, 8)}...`);
      this.sendConnect(connectResolve, connectReject, connectTimeout);
      return;
    }

    // Response to a pending request
    if (frame.type === 'res' && frame.id) {
      const pending = this.pending.get(frame.id);
      if (pending) {
        this.pending.delete(frame.id);
        if (frame.ok !== false) {
          pending.resolve(frame.payload);
        } else {
          pending.reject(
            new Error(frame.error?.message || `request failed: ${JSON.stringify(frame.error)}`)
          );
        }
      }
      return;
    }

    // Events
    if (frame.type === 'event' && frame.event) {
      if (frame.event === 'tick') return;

      // Chat events: route by runId to specific waiters
      if (frame.event === 'chat' && frame.payload?.runId) {
        const waiter = this.chatWaiters.get(frame.payload.runId);
        if (waiter) {
          waiter.handler(frame.payload);
          return; // 已由 waiter 处理，跳过全局 handler
        }
      }

      const handler = this.eventHandlers.get(frame.event);
      if (handler) handler(frame.payload);
    }
  }

  private sendConnect(
    resolve: (value: void) => void,
    reject: (err: Error) => void,
    timeout: NodeJS.Timeout
  ): void {
    const id = randomUUID();
    const role = 'operator';
    const scopes = ['operator.admin', 'operator.write'];
    const signedAtMs = Date.now();
    const nonce = this.connectNonce ?? undefined;
    const device = this.deviceIdentity
      ? (() => {
          const payload = buildDeviceAuthPayload({
            deviceId: this.deviceIdentity!.deviceId,
            clientId: 'gateway-client',
            clientMode: 'backend',
            role,
            scopes,
            signedAtMs,
            token: this.token || null,
            nonce,
          });
          return {
            id: this.deviceIdentity!.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(this.deviceIdentity!.publicKeyPem),
            signature: signDevicePayload(this.deviceIdentity!.privateKeyPem, payload),
            signedAt: signedAtMs,
            nonce,
          };
        })()
      : undefined;

    const params = {
      minProtocol: 1,
      maxProtocol: 3,
      client: {
        id: 'gateway-client',
        displayName: 'QQ Channel',
        version: '1.3.0',
        platform: 'linux',
        mode: 'backend',
      },
      caps: [],
      auth: { token: this.token },
      role,
      // chat.send 需要 operator.write，仅申请 admin 会在网关侧被拒绝
      scopes,
      device,
    };

    const frame = { type: 'req', id, method: 'connect', params };

    this.pending.set(id, {
      resolve: () => {
        clearTimeout(timeout);
        this._connected = true;
        this.connectPromise = null;
        this.logger?.info('[OpenClaw] Gateway 认证成功');
        this.startHeartbeat();
        resolve();
      },
      reject: (err: Error) => {
        clearTimeout(timeout);
        this._connected = false;
        this.connectPromise = null;
        this.logger?.error(`[OpenClaw] Gateway 认证失败: ${err.message}`);
        reject(err);
      },
    });

    this.ws!.send(JSON.stringify(frame));
    this.logger?.info('[OpenClaw] 已发送 connect 请求');
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPong = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (!this._connected || this.ws?.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }
      if (Date.now() - this.lastPong > 30000) {
        this.logger?.warn('[OpenClaw] 心跳超时，关闭连接');
        this.ws?.close(4000, 'heartbeat timeout');
        return;
      }
      try { this.ws!.ping(); } catch {}
    }, 15000);

    this.ws?.on('pong', () => { this.lastPong = Date.now(); });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this._destroyed) return;
    if (this.reconnectTimer) return;
    this.logger?.info('[OpenClaw] 5 秒后自动重连...');
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        this.logger?.info('[OpenClaw] 自动重连成功');
      } catch (e: any) {
        this.logger?.warn(`[OpenClaw] 自动重连失败: ${e.message}`);
        this.scheduleReconnect();
      }
    }, 5000);
  }

  async request(method: string, params: any): Promise<any> {
    if (!this._connected || this.ws?.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    const id = randomUUID();
    const frame = { type: 'req', id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timeout: ${method}`));
      }, 180000);

      this.pending.set(id, {
        resolve: (payload: any) => {
          clearTimeout(timeout);
          resolve(payload);
        },
        reject: (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }

  disconnect(): void {
    this._destroyed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, 'plugin cleanup'); } catch {}
      this.ws = null;
    }
    this._connected = false;
    this.connectPromise = null;
  }
}
