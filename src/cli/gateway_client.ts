import { WebSocket } from "ws";

export interface GatewayRpcResponse<T = unknown> {
  id: string;
  type: "res";
  ok: boolean;
  payload?: T;
  error?: string;
}

export interface GatewayStreamEvent {
  type: "event";
  event: string;
  payload: Record<string, unknown>;
}

export type GatewayConnectionState = "connected" | "disconnected";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * GatewayCliClient is a tiny WS RPC client shared by TUI-style entry points.
 *
 * It speaks the same methods as the browser control-ui so TUI and web can
 * read the same session/chat state from the gateway.
 */
export class GatewayCliClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<string, PendingRequest>();

  constructor(
    private readonly url: string,
    private readonly onEvent?: (event: GatewayStreamEvent) => void,
    private readonly onConnectionStateChange?: (state: GatewayConnectionState) => void,
  ) {}

  get isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(timeoutMs: number = 1200) {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => {
        ws.removeAllListeners();
        try { ws.close(); } catch {}
        reject(new Error(`gateway connect timeout: ${this.url}`));
      }, timeoutMs);

      ws.on("open", () => {
        clearTimeout(timer);
        this.ws = ws;
        this.onConnectionStateChange?.("connected");
        resolve();
      });

      ws.on("message", (raw) => this.handleMessage(raw.toString()));
      ws.on("error", (error) => {
        clearTimeout(timer);
        this.onConnectionStateChange?.("disconnected");
        reject(error);
      });

      ws.on("close", () => {
        this.rejectPending(new Error("gateway connection closed"));
        this.ws = null;
        this.onConnectionStateChange?.("disconnected");
      });
    });
  }

  close() {
    this.rejectPending(new Error("gateway client closed"));
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.onConnectionStateChange?.("disconnected");
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}) {
    await this.connect();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway not connected");
    }

    const id = `rpc_${Date.now()}_${this.requestId++}`;
    const payload = JSON.stringify({ id, method, params });
    const response = await new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.ws!.send(payload, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });

    return response;
  }

  private handleMessage(raw: string) {
    const message = JSON.parse(raw) as GatewayRpcResponse | GatewayStreamEvent;
    if (message.type === "res") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.payload);
      } else {
        pending.reject(new Error(message.error || "gateway rpc error"));
      }
      return;
    }

    if (message.type === "event") {
      this.onEvent?.(message);
    }
  }

  private rejectPending(error: Error) {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
