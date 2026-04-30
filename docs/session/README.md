# Session 模块说明

## 边界

- `Session`：保存原始发生过什么
  - 用户消息
  - 助手消息
  - 工具摘要
  - tool/action 审计日志
  - 大型结果 artifacts
- `Memory`：保存长期抽取后值得记住什么
  - 用户偏好
  - 领域知识片段
  - 检索记忆
- `Runtime State`：保存当前执行到哪一步
  - 当前回合状态
  - budget / fallback / tool loop 进度

`SessionManager` 不直接写 `USER.md`、`MEMORY.md` 或 `retrieval_memory.jsonl`。  
当会话结束时，只通过 `onSessionEnd()` 暴露抽取材料给 Memory 侧异步消费。

## 文件结构

```txt
src/session/
  SessionManager.ts
  SessionStore.ts
  SQLiteSessionStore.ts
  SessionSearch.ts
  SessionCompressor.ts
  SessionRouter.ts
  types.ts

src/action/
  ActionLogStore.ts
  types.ts

src/artifacts/
  ArtifactStore.ts
  types.ts
```

## SQLite Schema

数据库路径：

```txt
~/.PetAgent/agents/<agent>/sessions/session.sqlite
```

核心表：

- `sessions`
- `messages`
- `messages_fts`
- `actions`
- `artifacts`

`messages_fts` 使用 SQLite FTS5；如果当前环境不支持 FTS5，会自动回退到 `LIKE` 搜索。

## 运行流程

```txt
用户输入
-> SessionRouter.resolveSessionKey()
-> SessionManager.getOrCreateSession()
-> append user message
-> load recentMessages + sessionSummary
-> PromptBuilder 构建 prompt
-> LLM 回复
-> append assistant message
-> tool call 写 actions / artifacts / tool message
-> updateLastActivity()
-> 超阈值时 SessionCompressor 生成 summary
-> session end 时 onSessionEnd() 暴露抽取材料
```

## Prompt 使用约束

Runtime 只从 Session 读取两类内容：

- `recentMessages`
- `sessionSummary`

不会把完整 session history 全量塞进 prompt。  
长消息默认优先使用 `content_summary`，大 tool result 默认只用摘要，完整内容留在 `artifacts` 里按需读取。

## 检索策略

`SessionSearch` 支持：

- FTS5
- LIKE fallback
- 简单中文 keyword split

搜索结果优先按关键字命中情况和时间排序，适合中文垂直业务场景下的短问短答回忆。

## Retention Policy

- 最近 30 天完整保留
- 超过 30 天且已经有 session summary 的旧会话，可以清理原始 message content
- 清理前必须保留 `content_summary`
- 大型 artifact 可按时间和大小裁剪内容

## Agent 接入示例

```ts
const sessions = new SessionManager({ homePaths, sessionId: "order-8899" });
await sessions.init();

await sessions.appendMessage("user", "订单 8899 的狗狗今天又吐了");

const { recentMessages, sessionSummary } = await sessions.loadPromptContext(12);
// PromptBuilder 只消费 recentMessages + sessionSummary

await sessions.appendMessage("assistant", "先停食 4 小时，少量饮水，若持续呕吐需就医。");

await sessions.appendToolUse("memory_search", { query: "狗狗 呕吐" });
await sessions.appendToolResult("memory_search", "找到 3 条相关记录", { success: true });

const extraction = await sessions.endCurrentSession();
// extraction 可交给 MemoryExtractor 异步处理
```
