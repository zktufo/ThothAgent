import type { LLMMessage } from "../../llm/index.js";
import { MemoryManager } from "./manager.js";
import { FileMemory } from "./file_memory.js";
import { RetrievalMemory } from "./retrieval_memory.js";
import { BuiltinMemoryProvider, ExternalFileMemoryProvider } from "./providers.js";

export function createLayeredMemoryManager(options: {
  sessionId: string;
  rootDir?: string;
  debug?: boolean;
  maxMemoryTokens?: number;
}) {
  // This helper shows the intended production wiring:
  // one manager, one built-in file store, one external file provider.
  const fileMemory = new FileMemory({
    rootDir: options.rootDir,
  });
  const retrievalMemory = new RetrievalMemory({
    jsonlPath: fileMemory.retrievalMemoryPath,
    dbPath: fileMemory.retrievalMemoryPath,
  });

  return new MemoryManager([
    new BuiltinMemoryProvider(fileMemory),
    new ExternalFileMemoryProvider(fileMemory, retrievalMemory),
  ], {
    sessionId: options.sessionId,
    debug: options.debug,
    maxMemoryTokens: options.maxMemoryTokens ?? 500,
  });
}

export async function runAgentTurnExample(input: {
  manager: MemoryManager;
  userInput: string;
  history?: LLMMessage[];
  callLLM: (messages: LLMMessage[]) => Promise<string>;
}) {
  // This is the exact lifecycle the agent should follow every turn.
  const snapshot = await input.manager.onTurnStart(input.userInput);
  const prompt = input.manager.buildMessages(input.userInput, input.history || [], snapshot);
  const answer = await input.callLLM(prompt.messages);
  input.manager.syncTurn(input.userInput, answer);
  input.manager.queuePrefetch(input.userInput);
  return {
    answer,
    snapshot,
    prompt,
  };
}
