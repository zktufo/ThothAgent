# Layered Memory MVP

这是一套适用于垂直业务领域 Agent 的分层 Memory 最小实现，目标是把不同性质的记忆拆开管理，再通过 `PromptBuilder` 编译为稳定、可控的 LLM context。

## 文件结构

```txt
skills/
  README.md

src/
  agent/
  cli/
  core/
  llm/
  memory/

src/memory/layered/
  types.ts
  provider.ts
  file_memory.ts
  retrieval_memory.ts
  providers.ts
  prompt_builder.ts
  manager.ts
  example_agent_integration.ts
  basic_test.ts
  index.ts

memory/layered/
  user_profile.json
  working_state.json
  session_summary.md
  retrieval_memory.jsonl

domain_context.md
MEMORY.md
```

## 分层设计

### 1. `user_profile.json`
- 用于长期稳定偏好与画像
- 结构化 JSON，方便程序读取和更新
- 当前 MVP 只做非常保守的自动更新，例如“叫我 X”“请直接一点”

### 2. `domain_context.md`
- 用于垂直业务规则、术语、流程、边界
- 低频更新，通常人工维护
- 进入 prompt 时会被整理成简短要点

### 额外保留：`MEMORY.md`
- 面向用户可见的记忆摘要视图
- 自动汇总用户画像、当前会话摘要、近期重要记忆
- 更友好，但不直接承担业务背景注入职责

### 3. `working_state.json`
- 用于当前执行态和流程控制
- 高频更新
- 默认不进入 prompt

### 4. `session_summary.md`
- 替代长 history
- 按轮数周期更新
- 进入 prompt 时只取摘要要点

### 5. `retrieval_memory.jsonl`
- 长期经验和历史记忆
- 第一版使用 JSONL + keyword/topK
- 检索结果只在缓存命中时参与当前 prompt
- 重检索通过 `queuePrefetch()` 后台执行

## 生命周期

```txt
用户输入
→ onTurnStart
→ provider.prefetch() 只读缓存
→ PromptBuilder.buildMessages()
→ 调用 LLM
→ syncTurn() 异步写 memory
→ queuePrefetch() 后台准备下一轮 retrieval cache
```

## 核心模块

### `MemoryManager`
- 统一生命周期调度
- 初始化 provider 一次
- provider 出错不会中断主流程
- 提供 `flushBackgroundTasks()` 方便测试或进程退出前收尾

### `MemoryProvider`
- 统一接口：`init / prefetch / syncTurn / queuePrefetch`
- `prefetch` 只返回轻量缓存结果
- `queuePrefetch` 负责耗时任务

### `FileMemory`
- 管理 `user_profile / domain_context / working_state / session_summary`
- 可单独被业务代码直接调用

### `RetrievalMemory`
- 管理 `retrieval_memory.jsonl`
- 提供 `append / search / warmQuery / getCached`
- 当前使用关键词重叠评分，后续可以替换为 embedding/vector

### `PromptBuilder`
- 把各层 memory 编译成：

```txt
<memory-context>

[User Profile]
- ...

[Domain Context]
- ...

[Session Summary]
- ...

[Relevant Memories]
- ...

</memory-context>
```

- 支持 `maxMemoryTokens`
- 裁剪优先级：
  `user_profile > domain_context > session_summary > retrieval`

## 接入方式

```ts
import { createLayeredMemoryManager, runAgentTurnExample } from "./memory/layered/index.js";

const manager = createLayeredMemoryManager({
  sessionId: "session-001",
  debug: true,
  maxMemoryTokens: 500,
});

const result = await runAgentTurnExample({
  manager,
  userInput: "帮我总结一下这个客户当前状态",
  history: [],
  callLLM: async (messages) => {
    return "这里替换成真实 LLM 调用";
  },
});
```

## 测试

构建后运行：

```bash
npm run build
node dist/memory/layered/basic_test.js
```

## 后续扩展建议

1. 将 `RetrievalMemory` 从 JSONL 升级为 SQLite + FTS 或 embedding
2. 为 `session_summary` 增加真正的摘要器，而不是简单滚动摘要
3. 给 `user_profile` 增加人工审核或置信度机制
4. 将 `working_state` 和业务 workflow engine 对接
