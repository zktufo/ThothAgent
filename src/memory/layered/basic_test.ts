import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { FileMemory } from "./file_memory.js";
import { MemoryManager } from "./manager.js";
import { RetrievalMemory } from "./retrieval_memory.js";
import { BuiltinMemoryProvider, ExternalFileMemoryProvider } from "./providers.js";

async function main() {
  // The test uses a temp directory so it never pollutes the real project memory files.
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "layered-memory-"));
  const fileMemory = new FileMemory({
    rootDir,
    projectRootDir: rootDir,
    domainMemoryPath: path.join(rootDir, "DOMAIN.md"),
    visibleMemoryPath: path.join(rootDir, "MEMORY.md"),
    userMemoryPath: path.join(rootDir, "USER.md"),
    retrievalMemoryPath: path.join(rootDir, "retrieval_memory.db"),
  });
  const retrievalMemory = new RetrievalMemory({
    jsonlPath: path.join(rootDir, "retrieval_memory.db"),
    dbPath: path.join(rootDir, "retrieval_memory.db"),
    topK: 5,
  });

  await fileMemory.init();
  await fileMemory.saveDomainMemory([
    "# DOMAIN.md",
    "",
    "- 当前 Agent 服务于垂直业务领域。",
    "- 回复必须遵守业务规则和流程边界。",
    "",
  ].join("\n"));
  await fileMemory.saveUserMemory([
    "# USER.md",
    "",
    "- 用户称呼：小张",
    "- 偏好：直接、工程化、先给结论",
    "",
  ].join("\n"));

  const manager = new MemoryManager([
    new BuiltinMemoryProvider(fileMemory),
    new ExternalFileMemoryProvider(fileMemory, retrievalMemory),
  ], {
    sessionId: "test-session",
    maxMemoryTokens: 220,
    debug: true,
  });

  const snapshot = await manager.onTurnStart("狗狗换粮后挑食怎么办");
  const prompt = manager.buildMessages("狗狗换粮后挑食怎么办", [], snapshot);

  assert.ok(prompt.memoryContext.includes("[MEMORY.md]"));
  assert.ok(prompt.memoryContext.includes("[USER.md]"));
  assert.ok(prompt.memoryContext.includes("[DOMAIN.md]"));
  assert.ok(prompt.messages.at(-1)?.content === "狗狗换粮后挑食怎么办");

  manager.syncTurn("以后请直接一点，叫我小张", "收到，我会更直接地给结论。");
  manager.queuePrefetch("以后请直接一点，叫我小张");
  await manager.flushBackgroundTasks();

  manager.syncTurn("这次这样先给结论再列风险很好，以后类似问题都这样", "收到，以后我会优先先给结论，再列风险和下一步。");
  manager.syncTurn("这次这样先给结论再列风险很好，以后类似问题都这样", "收到，我会继续保持先给结论再列风险。");
  manager.onMemoryWrite({
    action: "add",
    target: "user",
    content: "用户偏好先给结论再列风险",
  });
  await manager.flushBackgroundTasks();

  const updatedWorkingState = await fileMemory.getWorkingState();
  const visibleMemory = await fileMemory.getVisibleMemorySummary();
  const externalHits = await fileMemory.searchExternalMemory("先给结论 再列风险", 5);
  const userMemory = await fileMemory.getUserMemory();
  const compaction = await fileMemory.compactExternalMemory({
    dedupeSimilarityThreshold: 0.7,
    maxRecordsPerCluster: 2,
    compactOlderThanDays: 0,
  });
  const compactedHits = await fileMemory.searchExternalMemory("先给结论 再列风险", 5);

  assert.equal(updatedWorkingState.lastUserInput, "这次这样先给结论再列风险很好，以后类似问题都这样");
  assert.equal(typeof visibleMemory, "string");
  assert.ok(userMemory.includes("用户称呼：小张"));
  assert.ok(externalHits.length >= 1, "external file memory should record long-term cross-session memories");
  assert.ok(compaction.deduped >= 1, "external memory should dedupe similar records");
  assert.ok(compactedHits.some((hit) => Array.isArray(hit.record.metadata?.compactedFrom)), "compaction should emit merged records");

  console.log("layered-memory basic test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
