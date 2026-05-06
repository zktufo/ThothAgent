import type { LLMMessage } from "../../llm/index.js";
import type { MemoryContextBlock, MemorySnapshot, PromptBuildInput, PromptBuildOutput } from "./types.js";

const PRIORITY_ORDER: Record<string, number> = {
  user_profile: 100,
  domain_context: 80,
  retrieval: 40,
};

export class PromptBuilder {
  buildMessages(input: PromptBuildInput): PromptBuildOutput {
    // PromptBuilder produces two things:
    // 1. memoryContext - a frozen snapshot of layered memory (injected into system prompt, not user messages)
    // 2. messages - the conversation history + current user input
    const maxMemoryTokens = input.maxMemoryTokens ?? 500;
    const includedBlocks = selectBlocks(input.snapshot.blocks, maxMemoryTokens);
    const memoryContext = renderMemoryContext(includedBlocks);
    const messages: LLMMessage[] = [];

    // Memory context is no longer injected as a user message.
    // It's returned separately and injected into the system prompt.
    // Only conversation history and current input go into messages.

    if (input.history?.length) {
      messages.push(...input.history);
    }

    messages.push({
      role: "user",
      content: input.userInput,
    });

    return {
      memoryContext,
      messages,
      usedTokensEstimate: includedBlocks.reduce((sum, block) => sum + block.tokensEstimate, 0),
      includedBlocks,
    };
  }
}

function selectBlocks(blocks: MemoryContextBlock[], maxMemoryTokens: number) {
  // Token budgeting is intentionally priority-first so stable profile/business context wins over retrieval.
  const sorted = [...blocks].sort((a, b) => {
    const priorityDiff = (b.priority ?? PRIORITY_ORDER[b.layer] ?? 0) - (a.priority ?? PRIORITY_ORDER[a.layer] ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    return a.title.localeCompare(b.title);
  });

  const selected: MemoryContextBlock[] = [];
  let used = 0;
  for (const block of sorted) {
    if (used + block.tokensEstimate <= maxMemoryTokens || selected.length === 0) {
      selected.push(block);
      used += block.tokensEstimate;
    }
  }
  return selected;
}

function renderMemoryContext(blocks: MemoryContextBlock[]) {
  if (!blocks.length) {
    return "<memory-context>\n(no relevant memory)\n</memory-context>";
  }

  return [
    "<memory-context>",
    "",
    ...blocks.map((block) => `[${block.title}]\n${block.content}`),
    "",
    "</memory-context>",
  ].join("\n");
}

export function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}
