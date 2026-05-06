import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { onboardUserHome } from "../home/index.js";
import { ModelManager } from "./index.js";

async function main() {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "thoth-agent-models-"));
  const homePaths = await onboardUserHome({ homeRoot, agentName: "tester" }).then((result) => result.paths);
  const manager = new ModelManager({ homePaths });

  const before = manager.getAgentModelConfig("tester");
  assert.equal(before.primary, "minimax-portal/MiniMax-M2.7");

  manager.updateProviderApiKey("minimax-portal", "test-minimax-key");
  manager.updateProviderOAuth("deepseek", {
    accessToken: "deepseek-oauth-token",
    refreshToken: "deepseek-refresh-token",
    accountLabel: "tester-account",
  });
  manager.setPrimaryModel("openai/gpt-4o-mini", "tester");
  manager.setFallbackModels(["minimax-portal/MiniMax-M2.7"], "tester");
  const createdAgent = await manager.ensureAgentRegistered("research-agent", {
    displayName: "Research Agent",
    primaryModel: "deepseek/deepseek-chat",
  });

  const list = manager.listModels();
  const after = manager.getAgentModelConfig("tester");
  const providers = manager.getConfiguredProviders("tester");
  const configText = fs.readFileSync(homePaths.thothAgentConfigPath, "utf-8");
  const agents = manager.listAgents();

  assert.ok(list.some((item) => item.route === "openai/gpt-4o-mini"));
  assert.ok(list.some((item) => item.route === "deepseek/deepseek-chat"));
  assert.equal(after.primary, "openai/gpt-4o-mini");
  assert.deepEqual(after.fallbacks, ["minimax-portal/MiniMax-M2.7"]);
  assert.ok(providers.length >= 1);
  assert.ok(configText.includes("\"models\""));
  assert.ok(configText.includes("\"agents\""));
  assert.ok(configText.includes("\"oauth\""));
  assert.equal(createdAgent.agentId, "research-agent");
  assert.ok(agents.some((item) => item.id === "research-agent"));

  console.log("model-manager basic test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
