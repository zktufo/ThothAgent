import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { onboardUserHome, readHomeDocuments, resolveUserHomePaths } from "./index.js";

async function main() {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pet-agent-home-"));
  const { paths, created } = await onboardUserHome({
    homeRoot,
    agentName: "tester",
    installDaemon: true,
  });

  assert.ok(paths.agentDataDir.endsWith(path.join("agents", "tester")));
  assert.ok(paths.workspaceDir.endsWith(path.join("workspace", "tester")));
  assert.ok(paths.sessionDbPath.endsWith(path.join("sessions", "session.sqlite")));
  assert.equal(paths.agentsFilePath, path.join(homeRoot, "AGENTS.md"));
  assert.equal(paths.agentName, "tester");
  assert.ok(fs.existsSync(paths.soulPath));
  assert.ok(fs.existsSync(paths.userPath));
  assert.ok(fs.existsSync(paths.visibleMemoryPath));
  assert.ok(fs.existsSync(paths.domainContextPath));
  assert.ok(fs.existsSync(paths.agentsFilePath));
  assert.ok(fs.existsSync(paths.dailyDir));
  assert.ok(fs.existsSync(paths.petAgentConfigPath));
  assert.ok(fs.existsSync(paths.daemonManifestPath));
  assert.ok(created.length > 0);
  const config = JSON.parse(fs.readFileSync(paths.petAgentConfigPath, "utf-8"));
  assert.equal(config.agents.defaults.agent, "main");
  assert.equal(config.agents.defaults.workspace, path.join(homeRoot, "workspace"));

  const docs = readHomeDocuments(paths);
  assert.ok(docs.soul.includes("毛孩子健康顾问"));
  assert.ok(docs.user.includes("用户称呼"));
  assert.ok(docs.memory.includes("记忆摘要"));

  const resolved = resolveUserHomePaths({ homeRoot, agentName: "tester" });
  assert.equal(resolved.agentRoot, paths.agentRoot);

  console.log("home basic test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
