import WebSocket from 'ws';
import { randomUUID } from 'crypto';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

interface ChatWaiter {
  handler: (payload: any) => void;
}

export class GatewayClient {
  private url: string;
  private token: string;
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
