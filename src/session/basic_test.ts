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
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "thoth-agent-session-"));
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
  assert.ok(fs.existsSync(homePaths.sessionIndexPath), "初始化后应生成 session.json 索引");
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
  for (let index = 0; index < 14; index += 1) {
    await store.appendMessage({
      sessionId: sessionA1.id,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `补充消息 ${index}：用于验证当前 session 压缩`,
    });
  }
  const compactedCurrent = await compressor.compactCurrentSession(sessionA1.id);
  assert.ok(compactedCurrent >= 1, "compactCurrentSession 应压缩旧消息原文");
  const compactedRows = store.db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE session_id = ?
      AND content IS NULL
      AND content_summary IS NOT NULL
  `).get(sessionA1.id) as { count: number };
  assert.ok(Number(compactedRows.count) >= 1, "当前会话压缩后应存在仅保留 summary 的消息");

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
  const indexedRaw = fs.readFileSync(homePaths.sessionIndexPath, "utf-8");
  const indexed = JSON.parse(indexedRaw) as { sessionId: string; sessionKey: string };
  assert.equal(indexed.sessionId, reset.next.id, "session.json 应始终指向最新 active session");

  const restoredManager = new SessionManager({
    homePaths,
    sessionId: "restored",
  });
  await restoredManager.init();
  const restoredSession = await restoredManager.getCurrentSession();
  assert.equal(restoredSession.id, reset.next.id, "新的 SessionManager 应优先通过 session.json 恢复 active session");
  const resolvedIndex = await restoredManager.resolveSessionIndex();
  assert.equal(resolvedIndex?.sessionId, reset.next.id, "resolveSessionIndex 应返回当前有效索引");

  fs.writeFileSync(homePaths.sessionIndexPath, JSON.stringify({
    sessionId: "missing-session",
    sessionKey: "missing:key",
    status: "active",
    title: "broken",
    updatedAt: new Date().toISOString(),
  }, null, 2));
  const repairedManager = new SessionManager({
    homePaths,
    sessionId: "repaired",
  });
  await repairedManager.init();
  const repairedSession = await repairedManager.getCurrentSession();
  assert.equal(repairedSession.id, reset.next.id, "坏掉的 session.json 应自动回退到 sqlite 中最近 active session");
  const repairedIndex = JSON.parse(fs.readFileSync(homePaths.sessionIndexPath, "utf-8")) as { sessionId: string };
  assert.equal(repairedIndex.sessionId, reset.next.id, "索引修复后应回写 session.json");

  await manager.appendToolUse("memory_search", { query: "比熊 挑食" });
  await manager.appendToolResult("memory_search", "找到 2 条相关记录", { success: true });
  const actions = await store.actions.listActions(reset.next.id);
  assert.ok(actions.some((action) => action.toolName === "memory_search"), "actions 应记录 tool 调用行为");

  const extraction = await store.onSessionEnd(sessionA1.id);
  assert.ok(extraction?.messages.length, "session end 应暴露可抽取材料");
  await store.saveArchivedSessionSummary(sessionA1.id, {
    markdown: "# Archived Session Summary\n\n- 用户提到比熊挑食并换了新粮。\n- 重点观察软便与精神状态。",
    updatedAt: new Date().toISOString(),
    source: "file",
  });
  const archivedHits = await store.searchArchivedSummaries("比熊 挑食 新粮", 5);
  assert.ok(archivedHits.length >= 1, "应支持在 session 层检索 archived summary");

  await store.endSession(sessionB.id);
  const reopened = await store.getOrCreateSession({
    ...routeB,
    sessionKey: router.resolveSessionKey(routeB),
  });
  assert.equal(reopened.id, sessionB.id, "同一个 ended session_key 应重新激活而不是重复创建");
  assert.equal(reopened.status, "active", "重新进入同一个 session_key 时应恢复为 active");

  const duplicateDbPath = path.join(homePaths.sessionsDir, "session-duplicate.sqlite");
  const duplicateStore = new SQLiteSessionStore({
    homePaths,
    dbPath: duplicateDbPath,
  });
  await duplicateStore.init();
  const activeA = await duplicateStore.createSession({
    ...routeA,
    sessionKey: "tenantA:user123:feishu:order:8899:legacy-a",
  });
  duplicateStore.db.prepare(`
    UPDATE sessions
    SET last_activity_at = ?
    WHERE id = ?
  `).run("2026-03-01T00:00:00.000Z", activeA.id);
  const activeB = await duplicateStore.createSession({
    ...routeA,
    sessionKey: "tenantA:user123:feishu:order:8899:legacy-b",
  });

  const repairedStore = new SQLiteSessionStore({
    homePaths,
    dbPath: duplicateDbPath,
  });
  await repairedStore.init();
  const repairedRows = repairedStore.db.prepare(`
    SELECT id, status
    FROM sessions
    WHERE tenant_id = ? AND user_id = ? AND channel = ? AND business_object_type = ? AND business_object_id = ?
    ORDER BY last_activity_at DESC
  `).all(routeA.tenantId, routeA.userId, routeA.channel, routeA.businessObjectType, routeA.businessObjectId) as Array<{ id: string; status: string }>;
  assert.equal(repairedRows[0]?.id, activeB.id, "最新 active session 应保留");
  assert.equal(repairedRows[0]?.status, "active", "最新 session 应维持 active");
  assert.equal(repairedRows[1]?.status, "archived", "旧的重复 active session 应自动归档");

  assert.ok(fs.existsSync(homePaths.sessionDbPath), "应生成 session.sqlite");
  console.log("session basic test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
