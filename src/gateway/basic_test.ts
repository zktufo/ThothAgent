import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onboardUserHome } from "../home/index.js";
import { PetGateway } from "./index.js";

async function main() {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pet-agent-gateway-"));
  process.env.PET_AGENT_HOME_ROOT = homeRoot;
  await onboardUserHome({ homeRoot, agentName: "tester" });

  const gateway = await PetGateway.create({ port: 0, host: "127.0.0.1" });
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

  assert.equal(status.status, "ok");
  assert.ok(Array.isArray(models.items));
  assert.ok(Array.isArray(sessions.items));
  assert.ok(cssText.includes(".shell"));

  await new Promise<void>((resolve, reject) => {
    gateway.httpServer.close((error) => error ? reject(error) : resolve());
  });

  console.log("gateway basic test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
