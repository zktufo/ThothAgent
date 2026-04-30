import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onboardUserHome } from "../home/index.js";
import { SessionRouter } from "./SessionRouter.js";
import { SQLiteSessionStore } from "./SQLiteSessionStore.js";
import { SessionManager } from "./SessionManager.js";
import { SessionCompressor } from "./SessionCompressor.js";

async function main() {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pet-agent-session-"));
  const homePaths = await onboardUserHome({ homeRoot, agentName: "tester" }).then((result) => result.paths);
  const router = new SessionRouter();
  const store = new SQLiteSessionStore({ homePaths });
  await store.init();

  const routeA = {
    tenantId: "tenantA",
    userId: "user123",
    channel: "feishu",
    businessObjectType: "order",
    businessObjectId: "8899",
  };
  const routeB = {
    ...routeA,
    businessObjectId: "9900",
  };

  const sessionA1 = await store.getOrCreateSession({
    ...routeA,
    sessionKey: router.resolveSessionKey(routeA),
  });
  const sessionA2 = await store.getOrCreateSession({
    ...routeA,
    sessionKey: router.resolveSessionKey(routeA),
  });
  const sessionB = await store.getOrCreateSession({
    ...routeB,
    sessionKey: router.resolveSessionKey(routeB),
  });

  assert.equal(sessionA1.id, sessionA2.id, "getOrCreateSession 应按 session_key 复用");
  assert.notEqual(sessionA1.id, sessionB.id, "不同 business_object_id 应创建不同 session");

  await store.appendMessage({
    sessionId: sessionA1.id,
    role: "user",
    content: "你好，我家比熊最近挑食，还偶尔软便。",
  });
  await store.appendMessage({
    sessionId: sessionA1.id,
    role: "assistant",
    content: "先观察精神、饮水和呕吐情况，再少量多次喂食。",
  });
  await store.appendMessage({
    sessionId: sessionA1.id,
    role: "user",
    content: "昨天换了新粮，今天精神还可以。",
  });

  const recent2 = await store.loadRecentMessages(sessionA1.id, 2);
  assert.equal(recent2.length, 2, "loadRecentMessages 应只返回最近 N 条");
  assert.equal(recent2[0]?.role, "assistant");
  assert.equal(recent2[1]?.role, "user");

  const manager = new SessionManager({
    homePaths,
    store,
    routeContext: routeA,
    artifactPolicy: {
      inlineMaxChars: 60,
    },
  });
  await manager.init();
  const longToolResult = "工具结果".repeat(80);
  const toolMessage = await manager.appendToolResult("session_search", longToolResult, { success: true });
  assert.ok(toolMessage.artifactId, "大 tool result 应写入 artifact");
  assert.notEqual(toolMessage.content, longToolResult, "大 tool result 不应完整塞入 messages.content");
  const artifact = await store.artifacts.getArtifact(toolMessage.artifactId!);
  assert.ok(artifact?.content?.includes("工具结果"), "artifact 应保存完整内容");

  const ftsHits = await store.searchMessages("挑食", { sessionId: sessionA1.id, limit: 5 });
  assert.ok(ftsHits.length >= 1, "FTS5 搜索应命中中文消息");

  const fallbackStore = new SQLiteSessionStore({
    homePaths,
    dbPath: path.join(homePaths.sessionsDir, "session-like.sqlite"),
    forceDisableFts: true,
  });
  await fallbackStore.init();
  const fallbackSession = await fallbackStore.createSession({
    ...routeA,
    sessionKey: "tenantA:user123:feishu:general",
  });
  await fallbackStore.appendMessage({
    sessionId: fallbackSession.id,
    role: "user",
    content: "猫咪绝育后今天不怎么吃饭。",
  });
  const likeHits = await fallbackStore.searchMessages("绝育 吃饭", {
    sessionId: fallbackSession.id,
    forceLike: true,
  });
  assert.ok(likeHits.length >= 1, "FTS5 不可用时应自动降级 LIKE 搜索");

  const compressor = new SessionCompressor(store, { messageThreshold: 3 });
  assert.equal(await compressor.shouldCompress(sessionA1.id), true, "消息超过阈值时应触发压缩");
  const summary = await compressor.compressSession(sessionA1.id);
  const summaryPayload = await store.loadSessionSummary(sessionA1.id);
  assert.ok(summary.includes("# Session Summary"));
  assert.ok(summaryPayload?.markdown.includes("用户"), "SessionCompressor 应生成 summary");

  store.db.prepare(`
    UPDATE sessions
    SET last_activity_at = ?
    WHERE id = ?
  `).run("2026-03-01T00:00:00.000Z", sessionA1.id);
  store.db.prepare(`
    UPDATE messages
    SET created_at = ?
    WHERE session_id = ?
  `).run("2026-03-01T00:00:00.000Z", sessionA1.id);
  const retention = await compressor.applyRetentionPolicy();
  const summaryAfterRetention = await store.loadSessionSummary(sessionA1.id);
  assert.ok(retention.sessionsScanned >= 1);
  assert.ok(summaryAfterRetention?.markdown.includes("Session Summary"), "RetentionPolicy 不应删除 summary");

  const child = await store.createChildSession({
    parentSessionId: sessionA1.id,
    title: "订单售后子会话",
  });
  assert.equal(child.parentSessionId, sessionA1.id, "createChildSession 应建立 parent_session_id");

  const reset = await manager.resetCurrentSession("重置后的新会话");
  assert.equal(reset.ended?.session.id, sessionA1.id, "resetCurrentSession 应结束当前会话");
  assert.notEqual(reset.next.id, sessionA1.id, "resetCurrentSession 应创建新的会话");
  assert.equal(reset.next.parentSessionId, sessionA1.id, "reset 后的新会话应挂到旧会话下面");
  const endedSession = await store.getSessionById(sessionA1.id);
  assert.equal(endedSession?.status, "ended", "reset 后旧会话应标记为 ended");

  await manager.appendToolUse("memory_search", { query: "比熊 挑食" });
  await manager.appendToolResult("memory_search", "找到 2 条相关记录", { success: true });
  const actions = await store.actions.listActions(reset.next.id);
  assert.ok(actions.some((action) => action.toolName === "memory_search"), "actions 应记录 tool 调用行为");

  const extraction = await store.onSessionEnd(sessionA1.id);
  assert.ok(extraction?.messages.length, "session end 应暴露可抽取材料");

  assert.ok(fs.existsSync(homePaths.sessionDbPath), "应生成 session.sqlite");
  console.log("session basic test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
