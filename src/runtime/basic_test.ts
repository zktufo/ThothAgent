import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { AgentRuntime } from "./index.js";
import { MemoryStore } from "../memory/index.js";
import { SessionManager } from "../session/index.js";
import { onboardUserHome } from "../home/index.js";

class FakeLLM {
  name = "fake-primary";
  usage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    maxTokens: 200_000,
    get usageFraction() { return 0; },
    get usageBar() { return ""; },
    add() {},
  };
  model = "fake-model";
  baseUrl = "fake://llm";

  isAvailable() {
    return true;
  }

  async chat() {
    return { text: "基于记忆整理出的回答。", content: [], stopReason: "end_turn", usage: this.usage };
  }

  async runToolLoop(_messages: any[], _systemPrompt: string, _tools: any[], executor: any, _maxSteps: number, onTrace?: any) {
    onTrace?.({ type: "tool_use", toolName: "memory_search", step: 1, input: { query: "狗狗挑食怎么办" } });
    const result = await executor("memory_search", { query: "狗狗挑食怎么办" });
    onTrace?.({ type: "tool_result", toolName: "memory_search", step: 1, input: { query: "狗狗挑食怎么办" }, message: result.message, success: result.success, error: result.error });
    return {
      text: "先少量多次观察，并逐步过渡新粮。",
      toolCalls: ["memory_search"],
      usage: this.usage,
    };
  }
}

class FailingLLM extends FakeLLM {
  name = "failing-primary";

  override async runToolLoop(
    ..._args: any[]
  ): Promise<{ text: string; toolCalls: string[]; usage: FakeLLM["usage"] }> {
    throw new Error("MiniMax API 超载 (529)，请稍后再试");
  }
}

async function main() {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pet-agent-runtime-"));
  const homePaths = await onboardUserHome({ homeRoot, agentName: "tester" }).then((result) => result.paths);
  const memory = new MemoryStore({ homePaths, sessionId: "test-session" });
  const sessions = new SessionManager({ homePaths, sessionId: "test-session" });

  await memory.remember("fact", "狗狗换粮过快后容易挑食或呕吐。", {
    tags: ["pet", "feeding"],
  });

  const runtime = new AgentRuntime({
    memory,
    sessions,
    llm: new FakeLLM() as any,
  });

  const result = await runtime.runTurn("狗狗挑食怎么办");
  const recent = await sessions.getRecentMessages(4);
  const promptContext = await sessions.loadPromptContext(4);

  assert.ok(result.text.includes("少量多次"));
  assert.ok(result.trace.some((event) => event.toolName === "memory_search"));
  assert.equal(recent.at(-1)?.role, "assistant");
  assert.ok(fs.existsSync(homePaths.sessionDbPath));
  assert.ok(Array.isArray(promptContext.recentMessages));

  const extraction = await runtime.endCurrentBusinessSession();
  const retrievalRecent = await memory.retrievalMemory.recent(10);
  assert.ok(extraction?.summaryMarkdown.includes("Session Summary"));
  assert.ok(retrievalRecent.some((item) => item.source === "session-extraction"));

  const fallbackRuntime = new AgentRuntime({
    memory: new MemoryStore({ homePaths, sessionId: "fallback-session" }),
    sessions: new SessionManager({ homePaths, sessionId: "fallback-session" }),
    llmProviders: [new FailingLLM() as any, new FakeLLM() as any],
  });
  const fallbackResult = await fallbackRuntime.runTurn("狗狗挑食怎么办");
  assert.ok(fallbackResult.text.includes("少量多次"));

  console.log("runtime basic test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
