/**
 * Pet-Agent Gateway — WebSocket + HTTP 服务
 *
 * 功能：
 * - WebSocket 协议：agent 请求/响应流式转发
 * - HTTP API：健康检查、会话管理
 * - WebUI 托管
 * - session 路由
 */
import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { PetAgent } from "../agent/index.js";
import { ensureUserHomeReady, type UserHomePaths } from "../home/index.js";
import { ModelManager } from "../model_manager/index.js";

export interface GatewayConfig {
  port: number;
  host: string;
  staticDir?: string;
}

interface GatewayClient {
  ws: WebSocket;
  id: string;
  connectedAt: number;
}

interface GatewayRequest {
  id: string;
  method: string;
  params: Record<string, any>;
}

interface GatewayResponse {
  id: string;
  type: "res";
  ok: boolean;
  payload?: any;
  error?: string;
}

interface GatewayEvent {
  type: "event";
  event: string;
  payload: any;
}

interface GatewayJsonBody {
  [key: string]: any;
}

export class PetGateway {
  readonly config: GatewayConfig;
  readonly httpServer: http.Server;
  readonly wss: WebSocketServer;
  readonly clients = new Map<string, GatewayClient>();
  readonly homePaths: UserHomePaths;
  readonly modelManager: ModelManager;
  agents = new Map<string, PetAgent>();

  private constructor(config: GatewayConfig, homePaths: UserHomePaths) {
    this.config = config;
    this.homePaths = homePaths;
    this.modelManager = new ModelManager({ homePaths });

    // HTTP 服务器
    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));

    // WebSocket 服务器
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
  }

  static async create(config: Partial<GatewayConfig> = {}): Promise<PetGateway> {
    const homePaths = await ensureUserHomeReady();
    return new PetGateway({
      port: config.port ?? 18889,
      host: config.host ?? "127.0.0.1",
      staticDir: config.staticDir || path.resolve(process.cwd(), "webui"),
    }, homePaths);
  }

  start(): void {
    this.httpServer.listen(this.config.port, this.config.host, () => {
      this.log("startup", `http://${this.config.host}:${this.config.port}`);
      console.log(`🐶 Pet-Gateway running on http://${this.config.host}:${this.config.port}`);
      console.log(`   WebSocket: ws://${this.config.host}:${this.config.port}`);
      console.log(`   WebUI:     http://${this.config.host}:${this.config.port}`);
      console.log(`   Health:    http://${this.config.host}:${this.config.port}/health`);
    });
  }

  stop(): void {
    this.wss.close();
    this.httpServer.close();
  }

  // ── WebSocket ──────────────────────────────────────────

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const client: GatewayClient = { ws, id: clientId, connectedAt: Date.now() };
    this.clients.set(clientId, client);
    this.log("ws.connect", `${clientId} ${req.socket.remoteAddress || "-"}`);

    ws.on("message", (raw) => this.handleMessage(client, raw));
    ws.on("close", () => {
      this.clients.delete(clientId);
      this.log("ws.close", clientId);
    });
    ws.on("error", (error) => {
      this.clients.delete(clientId);
      this.log("ws.error", `${clientId} ${String((error as Error)?.message || error)}`);
    });

    // 发送连接确认
    this.send(client, {
      type: "event",
      event: "connected",
      payload: { clientId, serverTime: new Date().toISOString() },
    });
  }

  private async handleMessage(client: GatewayClient, raw: WebSocket.RawData): Promise<void> {
    let req: GatewayRequest;
    try {
      req = JSON.parse(raw.toString());
    } catch {
      this.log("ws.parse_error", client.id);
      this.sendError(client, "parse_error", "Invalid JSON");
      return;
    }

    this.log("ws.rpc", `${client.id} ${req.method}`);

    try {
      if (req.method === "agent" || req.method === "chat.send") {
        await this.handleAgentRequest(client, req);
      } else if (req.method === "health") {
        this.send(client, { id: req.id, type: "res", ok: true, payload: { status: "ok", uptime: process.uptime() } });
      } else if (req.method === "status") {
        this.send(client, { id: req.id, type: "res", ok: true, payload: await this.buildStatusPayload() });
      } else if (req.method === "models.list") {
        this.send(client, { id: req.id, type: "res", ok: true, payload: await this.buildModelsPayload() });
      } else if (req.method === "models.route") {
        this.send(client, { id: req.id, type: "res", ok: true, payload: await this.patchModelRoutePayload(req.params || {}) });
      } else if (req.method === "sessions.list") {
        this.send(client, { id: req.id, type: "res", ok: true, payload: await this.buildSessionsPayload(req.params || {}) });
      } else if (req.method === "sessions.resolve") {
        this.send(client, { id: req.id, type: "res", ok: true, payload: await this.resolveSessionPayload(req.params || {}) });
      } else if (req.method === "chat.history") {
        this.send(client, { id: req.id, type: "res", ok: true, payload: await this.buildChatHistoryPayload(req.params || {}) });
      } else if (req.method === "sessions.patch") {
        this.send(client, { id: req.id, type: "res", ok: true, payload: await this.patchSessionPayload(req.params || {}) });
      } else if (req.method === "ping") {
        this.send(client, { id: req.id, type: "res", ok: true, payload: { pong: true } });
      } else {
        this.sendError(client, req.id, `Unknown method: ${req.method}`);
      }
    } catch (error: any) {
      this.log("ws.rpc_error", `${req.method} ${String(error?.message || error)}`);
      this.sendError(client, req.id, String(error?.message || error));
    }
  }

  private async handleAgentRequest(client: GatewayClient, req: GatewayRequest): Promise<void> {
    const params = req.params || {};
    const input = String(params.message || "");
    if (!input) {
      this.sendError(client, req.id, "message required");
      return;
    }

    // 获取/创建 agent
    const agentId = String(params.agentId || this.homePaths.agentName || "main");
    const agent = this.getOrCreateAgent(agentId);
    this.log("chat.send", `${agentId} ${input.slice(0, 80).replace(/\s+/g, " ")}`);

    // 流式处理
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    try {
      this.send(client, {
        id: req.id, type: "res", ok: true,
        payload: {
          runId,
          status: "accepted",
          acceptedAt: new Date().toISOString(),
          session: await agent.runtime.sessions.getCurrentSession(),
        },
      });

      const result = await agent.thinkWithTrace(input, undefined, (traceEvent) => {
        const ev: GatewayEvent = {
          type: "event",
          event: "chat.stream",
          payload: { runId, stream: "tool", data: traceEvent },
        };
        this.send(client, ev);
      });

      // 发送 timings
      if ((result as any).timings) {
        this.send(client, {
          type: "event",
          event: "chat.stream",
          payload: { runId, stream: "timing", data: (result as any).timings },
        });
      }

      // 发送最终结果
      const session = await agent.runtime.sessions.getCurrentSession();
      this.log("chat.done", `${runId} ${session.sessionKey}`);
      this.send(client, {
        type: "event",
        event: "chat.stream",
        payload: {
          runId,
          stream: "lifecycle",
          phase: "end",
          text: result.text,
          startedAt: "",
          endedAt: new Date().toISOString(),
          session,
        },
      });

    } catch (error: any) {
      this.log("chat.error", `${runId} ${String(error?.message || error)}`);
      this.send(client, {
        type: "event",
        event: "chat.stream",
        payload: { runId, stream: "lifecycle", phase: "error", error: error.message },
      });
    }
  }

  // ── HTTP ───────────────────────────────────────────────

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    this.log("http", `${req.method || "GET"} ${url.pathname}`);

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      void this.handleStatus(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/models") {
      void this.handleModels(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      void this.handleSessions(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agent") {
      void this.readJsonBody(req)
        .then((params) => this.handleHttpAgent(params, res))
        .catch((error) => this.sendJson(res, 500, { error: String(error?.message || error) }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/session/reset") {
      void this.readJsonBody(req)
        .then((params) => this.handleResetSession(params, res))
        .catch((error) => this.sendJson(res, 500, { error: String(error?.message || error) }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/session/end") {
      void this.readJsonBody(req)
        .then((params) => this.handleEndSession(params, res))
        .catch((error) => this.sendJson(res, 500, { error: String(error?.message || error) }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/model/route") {
      void this.readJsonBody(req)
        .then((params) => this.handleModelRoute(params, res))
        .catch((error) => this.sendJson(res, 500, { error: String(error?.message || error) }));
      return;
    }

    if (url.pathname === "/health") {
      this.sendJson(res, 200, { status: "ok", uptime: process.uptime(), clients: this.clients.size });
      return;
    }

    // WebUI static
    this.serveStatic(url.pathname, res);
  }

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    const staticDir = this.config.staticDir!;
    let filePath = pathname === "/" ? "index.html" : pathname.slice(1);

    // 尝试多个路径
    const candidates = [
      path.join(staticDir, filePath),
      path.join(staticDir, filePath + ".html"),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const ext = path.extname(candidate).toLowerCase();
        const mime: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "application/javascript",
          ".css": "text/css",
          ".json": "application/json",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".svg": "image/svg+xml",
          ".ico": "image/x-icon",
        };
        res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
        res.end(fs.readFileSync(candidate));
        return;
      }
    }

    res.writeHead(404);
    res.end("Not Found");
  }

  // ── 辅助 ───────────────────────────────────────────────

  private send(client: GatewayClient, payload: GatewayResponse | GatewayEvent): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(payload));
    }
  }

  private sendError(client: GatewayClient, id: string, error: string): void {
    this.send(client, { id, type: "res", ok: false, error });
  }

  private getOrCreateAgent(agentId: string) {
    if (!this.agents.has(agentId)) {
      this.agents.set(agentId, new PetAgent({}));
    }
    return this.agents.get(agentId)!;
  }

  private async handleHttpAgent(params: GatewayJsonBody, res: http.ServerResponse) {
    const input = String(params.message || "");
    if (!input) {
      this.sendJson(res, 400, { error: "message required" });
      return;
    }
    const agentId = String(params.agentId || this.homePaths.agentName || "main");
    const agent = this.getOrCreateAgent(agentId);
    const result = await agent.thinkWithTrace(input);
    this.sendJson(res, 200, {
      text: result.text,
      trace: result.trace,
      timings: result.timings || [],
      sessionKey: (await agent.runtime.sessions.getCurrentSession()).sessionKey,
      model: agent.runtime.lastProviderLabel,
    });
  }

  private async handleStatus(res: http.ServerResponse) {
    this.sendJson(res, 200, await this.buildStatusPayload());
  }

  private async handleModels(res: http.ServerResponse) {
    this.sendJson(res, 200, await this.buildModelsPayload());
  }

  private async handleSessions(res: http.ServerResponse) {
    this.sendJson(res, 200, await this.buildSessionsPayload({}));
  }

  private async handleResetSession(params: GatewayJsonBody, res: http.ServerResponse) {
    const agentId = String(params.agentId || this.homePaths.agentName || "default");
    const agent = this.getOrCreateAgent(agentId);
    const reset = await agent.runtime.sessions.resetCurrentSession("Gateway 重置的新会话");
    await agent.memory.clearSession();
    this.log("sessions.reset", `${agentId} -> ${reset.next.sessionKey}`);
    this.sendJson(res, 200, {
      ok: true,
      previous: reset.ended?.session || null,
      next: reset.next,
    });
  }

  private async handleEndSession(params: GatewayJsonBody, res: http.ServerResponse) {
    const agentId = String(params.agentId || this.homePaths.agentName || "default");
    const agent = this.getOrCreateAgent(agentId);
    const extraction = await agent.runtime.endCurrentBusinessSession();
    const next = await agent.runtime.sessions.createChildSession("Gateway 结束后的新会话", {
      startedAfterEnd: extraction?.session.id || null,
    });
    await agent.memory.clearSession();
    this.log("sessions.end", `${agentId} -> ${next.sessionKey}`);
    this.sendJson(res, 200, {
      ok: true,
      ended: extraction?.session || null,
      summary: extraction?.summaryMarkdown || "",
      next,
    });
  }

  private async handleModelRoute(params: GatewayJsonBody, res: http.ServerResponse) {
    const agentId = String(params.agentId || this.homePaths.agentName || "default");
    const primary = String(params.primary || "");
    const fallbacks = Array.isArray(params.fallbacks)
      ? params.fallbacks.map((item) => String(item)).filter(Boolean)
      : [];
    if (!primary) {
      this.sendJson(res, 400, { error: "primary required" });
      return;
    }

    this.modelManager.setPrimaryModel(primary, agentId);
    this.modelManager.setFallbackModels(fallbacks, agentId);
    this.agents.delete(agentId);
    this.log("models.route", `${agentId} primary=${primary} fallbacks=${fallbacks.join(",") || "(none)"}`);
    this.sendJson(res, 200, {
      ok: true,
      current: this.modelManager.getAgentModelConfig(agentId),
    });
  }

  private async buildStatusPayload() {
    const agentId = this.homePaths.agentName || "default";
    const agent = this.getOrCreateAgent(agentId);
    const session = await agent.runtime.sessions.getCurrentSession();
    const currentModel = this.modelManager.getAgentModelConfig(agentId);
    return {
      status: "ok",
      uptime: process.uptime(),
      clients: this.clients.size,
      agents: this.agents.size,
      gateway: {
        host: this.config.host,
        port: this.config.port,
      },
      runtime: {
        agentId,
        sessionKey: session.sessionKey,
        sessionId: session.id,
        modelRoute: currentModel,
        activeModel: agent.runtime.lastProviderLabel,
        tokenUsage: {
          totalTokens: agent.llm.usage.totalTokens,
          maxTokens: agent.llm.usage.maxTokens,
          usageFraction: agent.llm.usage.usageFraction,
        },
      },
      home: {
        root: this.homePaths.homeRoot,
        agentDataDir: this.homePaths.agentDataDir,
        workspaceDir: this.homePaths.workspaceDir,
        configPath: this.homePaths.petAgentConfigPath,
      },
    };
  }

  private async buildModelsPayload() {
    const agentId = this.homePaths.agentName || "default";
    return {
      current: this.modelManager.getAgentModelConfig(agentId),
      items: this.modelManager.listModels(),
    };
  }

  private async buildSessionsPayload(params: GatewayJsonBody) {
    const agentId = String(params.agentId || this.homePaths.agentName || "default");
    const limit = typeof params.limit === "number" ? params.limit : 20;
    const agent = this.getOrCreateAgent(agentId);
    const sessions = await agent.runtime.sessions.listSessions({ limit, status: "all" });
    const items = await Promise.all(
      sessions.map(async (session) => ({
        ...session,
        summary: await agent.runtime.sessions.loadSessionSummary(session.id),
        actions: await agent.runtime.sessions.listSessionActions(session.id),
      })),
    );
    return {
      items,
      currentSessionId: await agent.runtime.sessions.getCurrentSessionId(),
    };
  }

  private async resolveSessionPayload(params: GatewayJsonBody) {
    const agentId = String(params.agentId || this.homePaths.agentName || "default");
    const agent = this.getOrCreateAgent(agentId);
    const session = await agent.runtime.sessions.resolveSession({
      sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
      sessionKey: typeof params.sessionKey === "string" ? params.sessionKey : undefined,
    });
    if (!session) {
      return { session: null, summary: null };
    }
    return {
      session,
      summary: await agent.runtime.sessions.loadSessionSummary(session.id),
    };
  }

  private async buildChatHistoryPayload(params: GatewayJsonBody) {
    const agentId = String(params.agentId || this.homePaths.agentName || "default");
    const limit = typeof params.limit === "number" ? params.limit : 60;
    const agent = this.getOrCreateAgent(agentId);
    const session = await agent.runtime.sessions.resolveSession({
      sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
      sessionKey: typeof params.sessionKey === "string" ? params.sessionKey : undefined,
    });
    if (!session) {
      return { session: null, summary: null, messages: [] };
    }
    return {
      session,
      summary: await agent.runtime.sessions.loadSessionSummary(session.id),
      messages: await agent.runtime.sessions.loadHistory(session.id, limit),
    };
  }

  private async patchSessionPayload(params: GatewayJsonBody) {
    const agentId = String(params.agentId || this.homePaths.agentName || "default");
    const action = String(params.action || "").trim();
    const agent = this.getOrCreateAgent(agentId);

    if (action === "reset") {
      const reset = await agent.runtime.sessions.resetCurrentSession(String(params.title || "Gateway 重置的新会话"));
      await agent.memory.clearSession();
      this.log("sessions.patch", `${agentId} reset -> ${reset.next.sessionKey}`);
      return { ok: true, action, previous: reset.ended?.session || null, next: reset.next };
    }

    if (action === "end") {
      const extraction = await agent.runtime.endCurrentBusinessSession();
      const next = await agent.runtime.sessions.createChildSession(String(params.title || "Gateway 结束后的新会话"), {
        startedAfterEnd: extraction?.session.id || null,
      });
      await agent.memory.clearSession();
      this.log("sessions.patch", `${agentId} end -> ${next.sessionKey}`);
      return { ok: true, action, ended: extraction?.session || null, summary: extraction?.summaryMarkdown || "", next };
    }

    throw new Error(`unsupported sessions.patch action: ${action || "(empty)"}`);
  }

  private async patchModelRoutePayload(params: GatewayJsonBody) {
    const agentId = String(params.agentId || this.homePaths.agentName || "default");
    const primary = String(params.primary || "");
    const fallbacks = Array.isArray(params.fallbacks)
      ? params.fallbacks.map((item) => String(item)).filter(Boolean)
      : [];
    if (!primary) {
      throw new Error("primary required");
    }

    this.modelManager.setPrimaryModel(primary, agentId);
    this.modelManager.setFallbackModels(fallbacks, agentId);
    this.agents.delete(agentId);
    this.log("models.route", `${agentId} primary=${primary} fallbacks=${fallbacks.join(",") || "(none)"}`);
    return {
      ok: true,
      current: this.modelManager.getAgentModelConfig(agentId),
    };
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<GatewayJsonBody> {
    let body = "";
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => resolve());
      req.on("error", reject);
    });
    return body.trim() ? JSON.parse(body) as GatewayJsonBody : {};
  }

  private sendJson(res: http.ServerResponse, status: number, payload: any) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  }

  private log(scope: string, message: string) {
    const stamp = new Date().toISOString().slice(11, 19);
    console.log(`[gateway ${stamp}] ${scope} ${message}`);
  }
}
