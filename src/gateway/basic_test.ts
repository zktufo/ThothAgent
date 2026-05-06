import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { onboardUserHome } from "../home/index.js";
import { ThothGateway } from "./index.js";

async function main() {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "thoth-agent-gateway-"));
  process.env.THOTH_AGENT_HOME_ROOT = homeRoot;
  await onboardUserHome({ homeRoot, agentName: "tester" });

  const gateway = await ThothGateway.create({ port: 0, host: "127.0.0.1" });
  const listened = await new Promise<boolean>((resolve) => {
    const onError = (error: NodeJS.ErrnoException) => {
      gateway.httpServer.off("listening", onListening);
      if (error.code === "EPERM") {
        console.log("gateway basic test skipped (sandbox denied listen)");
        resolve(false);
        return;
      }
      throw error;
    };
    const onListening = () => {
      gateway.httpServer.off("error", onError);
      resolve(true);
    };
    gateway.httpServer.once("error", onError);
    gateway.httpServer.once("listening", onListening);
    gateway.httpServer.listen(0, "127.0.0.1");
  });
  if (!listened) return;

  const address = gateway.httpServer.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const [statusRes, modelsRes, sessionsRes, staticRes] = await Promise.all([
    fetch(`${baseUrl}/api/status`),
    fetch(`${baseUrl}/api/models`),
    fetch(`${baseUrl}/api/sessions`),
    fetch(`${baseUrl}/styles.css`),
  ]);

  const status = await statusRes.json();
  const models = await modelsRes.json();
  const sessions = await sessionsRes.json();
  const cssText = await staticRes.text();

  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const rpc = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const id = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const handler = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "res" || message.id !== id) return;
      ws.off("message", handler);
      if (message.ok) resolve(message.payload);
      else reject(new Error(message.error || "rpc failed"));
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });

  const agentListBefore = await rpc("agents.list");
  const createdAgent = await rpc("agents.create", {
    agentId: "research-agent",
    displayName: "Research Agent",
    primaryModel: "openai/gpt-4o-mini",
  });
  const agentListAfter = await rpc("agents.list");

  assert.equal(status.status, "ok");
  assert.ok(status.observability?.scheduler);
  assert.ok(Array.isArray(models.items));
  assert.ok(Array.isArray(sessions.items));
  assert.ok(cssText.includes(".shell"));
  assert.ok(Array.isArray(agentListBefore.items));
  assert.equal(createdAgent.agent.id, "research-agent");
  assert.ok(agentListAfter.items.some((item: any) => item.id === "research-agent"));

  ws.close();

  await new Promise<void>((resolve, reject) => {
    gateway.httpServer.close((error) => error ? reject(error) : resolve());
  });

  console.log("gateway basic test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
