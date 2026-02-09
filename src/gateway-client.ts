import WebSocket from 'ws';
import { randomUUID } from 'crypto';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export class GatewayClient {
  private url: string;
  private token: string;
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  public eventHandlers = new Map<string, (payload: any) => void>();
  private _connected = false;
  private connectPromise: Promise<void> | null = null;
  private connectNonce: string | null = null;
  private logger: any;

  constructor(url: string, token: string, logger?: any) {
    this.url = url;
    this.token = token;
    this.logger = logger;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    if (this._connected && this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
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
        for (const [, p] of this.pending) {
          p.reject(new Error(`ws closed: ${code}`));
        }
        this.pending.clear();
      });

      this.ws.on('error', (err: Error) => {
        this.logger?.error(`[OpenClaw] WS 错误: ${err.message}`);
        clearTimeout(timeout);
        this._connected = false;
        this.connectPromise = null;
        reject(err);
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

    // Events (chat, agent, tick, etc.)
    if (frame.type === 'event' && frame.event) {
      if (frame.event === 'tick') return;
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
    const params = {
      minProtocol: 1,
      maxProtocol: 3,
      client: {
        id: 'gateway-client',
        displayName: 'QQ Channel',
        version: '1.0.0',
        platform: 'linux',
        mode: 'backend',
      },
      caps: [],
      auth: { token: this.token },
      role: 'operator',
      scopes: ['operator.admin'],
    };

    const frame = { type: 'req', id, method: 'connect', params };

    this.pending.set(id, {
      resolve: () => {
        clearTimeout(timeout);
        this._connected = true;
        this.connectPromise = null;
        this.logger?.info('[OpenClaw] Gateway 认证成功');
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
    if (this.ws) {
      try {
        this.ws.close(1000, 'plugin cleanup');
      } catch {}
      this.ws = null;
    }
    this._connected = false;
    this.connectPromise = null;
  }
}
