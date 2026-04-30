import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { FileMemory } from "./file_memory.js";
import { MemoryManager } from "./manager.js";
import { RetrievalMemory } from "./retrieval_memory.js";
import { FileMemoryProvider, RetrievalMemoryProvider, VisibleMemorySummaryProvider } from "./providers.js";

async function main() {
  // The test uses a temp directory so it never pollutes the real project memory files.
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "layered-memory-"));
  const fileMemory = new FileMemory({
    rootDir,
    projectRootDir: rootDir,
    domainContextPath: path.join(rootDir, "domain_context.md"),
    visibleMemoryPath: path.join(rootDir, "MEMORY.md"),
  });
  const retrievalMemory = new RetrievalMemory({
    filePath: path.join(rootDir, "retrieval_memory.jsonl"),
    topK: 3,
  });

  await fileMemory.init();
  await fileMemory.saveDomainContext([
    "# Domain Context",
    "",
    "- 当前 Agent 服务于垂直业务领域。",
    "- 回复必须遵守业务规则和流程边界。",
    "",
  ].join("\n"));
  await fileMemory.updateUserProfile({
    displayName: "小张",
    preferences: {
      answerStyle: "direct",
      responseLength: "concise",
      formatting: ["bullet points"],
    },
    traits: ["用户偏好工程化回答"],
  });

  await retrievalMemory.init();
  await retrievalMemory.append({
    kind: "fact",
    text: "用户上次提到狗狗换粮太快后出现呕吐和挑食。",
    tags: ["pet", "feeding"],
    source: "manual-seed",
  });
  await retrievalMemory.append({
    kind: "fact",
    text: "猫咪绝育后出现食欲下降和肠胃应激，需要少量多次进食。",
    tags: ["pet", "post-op"],
    source: "semantic-seed",
  });
  await retrievalMemory.warmQuery("狗狗换粮后挑食怎么办", 3);
  const semanticHits = await retrievalMemory.search("猫猫做完手术后不爱吃饭怎么办", 3);

  const manager = new MemoryManager([
    new FileMemoryProvider(fileMemory, { summaryEveryTurns: 1 }),
    new RetrievalMemoryProvider(retrievalMemory, 3),
    new VisibleMemorySummaryProvider(fileMemory, retrievalMemory),
  ], {
    sessionId: "test-session",
    maxMemoryTokens: 220,
    debug: true,
  });

  const snapshot = await manager.onTurnStart("狗狗换粮后挑食怎么办");
  const prompt = manager.buildMessages("狗狗换粮后挑食怎么办", [], snapshot);

  assert.ok(prompt.memoryContext.includes("[User Profile]"));
  assert.ok(prompt.memoryContext.includes("[Domain Context]"));
  assert.ok(prompt.memoryContext.includes("[Relevant Memories]"));
  assert.ok(prompt.messages.at(-1)?.content === "狗狗换粮后挑食怎么办");
  assert.ok(semanticHits.some((hit) => hit.source === "semantic-seed"));
  const retrievalFile = fs.readFileSync(path.join(rootDir, "retrieval_memory.jsonl"), "utf-8");
  assert.ok(retrievalFile.includes("\"embedding\""));

  manager.syncTurn("以后请直接一点，叫我小张", "收到，我会更直接地给结论。");
  manager.queuePrefetch("以后请直接一点，叫我小张");
  await manager.flushBackgroundTasks();

  const updatedProfile = await fileMemory.getUserProfile();
  const updatedWorkingState = await fileMemory.getWorkingState();
  const summary = await fileMemory.getSessionSummary();
  const visibleMemory = await fileMemory.getVisibleMemorySummary();
  const cachedHits = retrievalMemory.getCached("以后请直接一点，叫我小张");

  assert.equal(updatedProfile.displayName, "小张");
  assert.equal(updatedProfile.preferences?.answerStyle, "direct and engineering-focused");
  assert.equal(updatedWorkingState.lastUserInput, "以后请直接一点，叫我小张");
  assert.ok(summary.includes("用户：以后请直接一点，叫我小张"));
  assert.ok(visibleMemory.includes("## 用户画像"));
  assert.ok(Array.isArray(cachedHits));

  console.log("layered-memory basic test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
