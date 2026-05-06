/**
 * LLM provider layer.
 *
 * This module now exposes:
 * - a shared provider interface
 * - MiniMax as the default anthropic-compatible provider
 * - optional OpenAI fallback provider
 * - default provider discovery from local config / env
 *
 * Runtime can use this to implement routing, fallback, and budget-aware behavior
 * without hard-coding one vendor everywhere.
 */
import fs from "fs";
import os from "os";
import path from "path";
import OpenAI from "openai";
import { Anthropic } from "@anthropic-ai/sdk";

export interface LLMMessage {
  role: "user" | "assistant";
  content: string | Array<Record<string, any>>;
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, any>;
    required?: string[];
    [key: string]: any;
  };
}

export interface LLMToolExecutionResult {
  success: boolean;
  message: string;
  data?: any;
  error?: string;
}

export interface ToolTraceEvent {
  type: "tool_use" | "tool_result";
  toolName: string;
  step: number;
  input?: Record<string, any>;
  message?: string;
  success?: boolean;
  error?: string;
}

export interface LLMResponse {
  text: string;
  content: Array<Record<string, any>>;
  stopReason: string | null | undefined;
  usage: TokenUsageTracker;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  maxTokens: number;
  get usageFraction(): number;
  get usageBar(): string;
}

export interface ProviderSettings {
  name: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly usage: TokenUsageTracker;
  isAvailable(): boolean;
  chat(
    messages: LLMMessage[],
    systemPrompt?: string,
    maxTokens?: number,
    options?: {
      tools?: LLMToolDefinition[];
      toolChoice?: Record<string, any>;
    }
  ): Promise<LLMResponse>;
  runToolLoop(
    messages: LLMMessage[],
    systemPrompt: string,
    tools: LLMToolDefinition[],
    executor: (toolName: string, input: Record<string, any>) => Promise<LLMToolExecutionResult>,
    maxSteps?: number,
    onTrace?: (event: ToolTraceEvent) => void
  ): Promise<{ text: string; toolCalls: string[]; usage: TokenUsageTracker }>;
}

export class TokenUsageTracker implements TokenUsage {
  promptTokens = 0;
  completionTokens = 0;
  totalTokens = 0;
  maxTokens = 200_000;

  add(prompt: number, completion: number) {
    this.promptTokens += prompt;
    this.completionTokens += completion;
    this.totalTokens += prompt + completion;
  }

  clone() {
    const tracker = new TokenUsageTracker();
    tracker.promptTokens = this.promptTokens;
    tracker.completionTokens = this.completionTokens;
    tracker.totalTokens = this.totalTokens;
    tracker.maxTokens = this.maxTokens;
    return tracker;
  }

  get usageFraction(): number {
    return this.totalTokens / this.maxTokens;
  }

  get usageBar(): string {
    const filled = Math.floor(this.usageFraction * 20);
    return "█".repeat(filled) + "░".repeat(Math.max(0, 20 - filled));
  }
}

abstract class BaseLLMProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly usage = new TokenUsageTracker();
  protected readonly apiKey: string;

  constructor(settings: ProviderSettings) {
    this.name = settings.name;
    this.model = settings.model;
    this.baseUrl = settings.baseUrl;
    this.apiKey = settings.apiKey;
  }

  isAvailable() {
    return Boolean(this.apiKey);
  }

  abstract chat(
    messages: LLMMessage[],
    systemPrompt?: string,
    maxTokens?: number,
    options?: {
      tools?: LLMToolDefinition[];
      toolChoice?: Record<string, any>;
    }
  ): Promise<LLMResponse>;

  async runToolLoop(
    messages: LLMMessage[],
    systemPrompt: string,
    tools: LLMToolDefinition[],
    executor: (toolName: string, input: Record<string, any>) => Promise<LLMToolExecutionResult>,
    maxSteps: number = 4,
    onTrace?: (event: ToolTraceEvent) => void
  ): Promise<{ text: string; toolCalls: string[]; usage: TokenUsageTracker }> {
    const workingMessages: LLMMessage[] = [...messages];
    const toolCalls: string[] = [];

    for (let step = 0; step < maxSteps; step += 1) {
      const response = await this.chat(workingMessages, systemPrompt, 2048, {
        tools,
        toolChoice: tools.length ? { type: "auto", disable_parallel_tool_use: false } : undefined,
      });

      workingMessages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter((block) => block.type === "tool_use");
      if (toolUses.length === 0) {
        return { text: response.text, toolCalls, usage: response.usage };
      }

      const toolResults = [];
      for (const toolUse of toolUses) {
        onTrace?.({
          type: "tool_use",
          toolName: toolUse.name,
          step: step + 1,
          input: toolUse.input ?? {},
        });
        const result = await executor(toolUse.name, toolUse.input ?? {});
        toolCalls.push(toolUse.name);
        onTrace?.({
          type: "tool_result",
          toolName: toolUse.name,
          step: step + 1,
          input: toolUse.input ?? {},
          message: result.message,
          success: result.success,
          error: result.error,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.message,
          is_error: !result.success,
        });
      }

      workingMessages.push({ role: "user", content: toolResults });
    }

    return {
      text: "⚠️ 工具调用轮次已达上限，请换种说法再试一次。",
      toolCalls,
      usage: this.usage,
    };
  }
}

export class AnthropicCompatibleLLM extends BaseLLMProvider {
  private client: Anthropic | null = null;

  constructor(settings?: Partial<ProviderSettings>) {
    super({
      name: "anthropic-compatible",
      model: "default-model",
      baseUrl: "",
      apiKey: "",
      ...(settings || {}),
    });
  }

  private ensureClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({
        apiKey: this.apiKey,
        baseURL: this.baseUrl,
      });
    }
    return this.client;
  }

  async chat(
    messages: LLMMessage[],
    systemPrompt: string = "",
    maxTokens: number = 2048,
    options: {
      tools?: LLMToolDefinition[];
      toolChoice?: Record<string, any>;
    } = {}
  ): Promise<LLMResponse> {
    const client = this.ensureClient();
    const allMessages: any[] = messages.map((msg) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    }));

    try {
      const response: any = await client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        messages: allMessages,
        system: systemPrompt || undefined,
        tools: options.tools?.length ? (options.tools as any) : undefined,
        tool_choice: options.toolChoice as any,
      } as any);

      let text = "";
      for (const block of response.content) {
        if (block.type === "text" && block.text) {
          text += (text ? "\n" : "") + block.text;
        }
      }

      const usage = response.usage;
      this.usage.add(usage.input_tokens, usage.output_tokens);

      return {
        text,
        content: response.content,
        stopReason: response.stop_reason,
        usage: this.usage,
      };
    } catch (error: any) {
      if (error?.status === 529 || error?.type === "overloaded_error") {
        throw new Error("MiniMax API 超载 (529)，请稍后再试");
      }
      throw error;
    }
  }
}

export class MiniMaxLLM extends AnthropicCompatibleLLM {
  constructor(settings?: Partial<ProviderSettings>) {
    super({
      ...loadProviderSettings(["minimax", "minimax-portal"], {
        name: "minimax",
        model: "MiniMax-M2.7",
        baseUrl: "https://api.minimaxi.com/anthropic",
        apiKey: "",
      }),
      ...(settings || {}),
    });
  }
}

export class OpenAICompatibleLLM extends BaseLLMProvider {
  private client: OpenAI | null = null;

  constructor(settings?: Partial<ProviderSettings>) {
    super({
      name: "openai-compatible",
      model: "default-model",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      ...(settings || {}),
    });
  }

  private ensureClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseUrl,
      });
    }
    return this.client;
  }

  async chat(
    messages: LLMMessage[],
    systemPrompt: string = "",
    maxTokens: number = 2048,
    options: {
      tools?: LLMToolDefinition[];
      toolChoice?: Record<string, any>;
    } = {}
  ): Promise<LLMResponse> {
    const client = this.ensureClient();
    const completion = await client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(messages, systemPrompt),
      max_tokens: maxTokens,
      tools: options.tools?.length ? options.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      })) : undefined,
      tool_choice: options.tools?.length
        ? normalizeOpenAIToolChoice(options.toolChoice)
        : undefined,
    });

    const choice = completion.choices[0];
    const message = choice?.message;
    const text = message?.content || "";
    const content: Array<Record<string, any>> = [];

    if (text) {
      content.push({ type: "text", text });
    }

    for (const toolCall of message?.tool_calls || []) {
      content.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.function.name,
        input: safeJsonParse(toolCall.function.arguments),
      });
    }

    this.usage.add(completion.usage?.prompt_tokens || 0, completion.usage?.completion_tokens || 0);

    return {
      text,
      content,
      stopReason: choice?.finish_reason,
      usage: this.usage,
    };
  }
}

export class OpenAILLM extends OpenAICompatibleLLM {
  constructor(settings?: Partial<ProviderSettings>) {
    super({
      ...loadProviderSettings(["openai"], {
        name: "openai",
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        apiKey: process.env.OPENAI_API_KEY || "",
      }),
      ...(settings || {}),
    });
  }
}

export function createDefaultProviders() {
  const providers: LLMProvider[] = [];
  const minimax = new MiniMaxLLM();
  if (minimax.isAvailable()) providers.push(minimax);

  const openai = new OpenAILLM();
  if (openai.isAvailable()) providers.push(openai);

  if (!providers.length) {
    providers.push(minimax);
  }

  return providers;
}

function loadProviderSettings(keys: string[], defaults: ProviderSettings): ProviderSettings {
  const configPath = path.join(os.homedir(), ".PetAgent", "PetAgent.json");
  let loaded = { ...defaults };

  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const providers = config?.models?.providers ?? {};
      for (const key of keys) {
        if (providers[key]) {
          loaded = {
            ...loaded,
            name: key,
            baseUrl: providers[key].baseUrl || loaded.baseUrl,
            apiKey: providers[key].apiKey || loaded.apiKey,
            model: providers[key].model || loaded.model,
          };
          break;
        }
      }
    }
  } catch {}

  if (loaded.name === "openai") {
    loaded.apiKey = process.env.OPENAI_API_KEY || loaded.apiKey;
    loaded.baseUrl = process.env.OPENAI_BASE_URL || loaded.baseUrl;
    loaded.model = process.env.OPENAI_MODEL || loaded.model;
  }

  return loaded;
}

function toOpenAIMessages(messages: LLMMessage[], systemPrompt: string) {
  const result: any[] = [];
  if (systemPrompt.trim()) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const message of messages) {
    if (typeof message.content === "string") {
      result.push({ role: message.role, content: message.content });
      continue;
    }

    const content = message.content;
    const toolResults = content.filter((item) => item.type === "tool_result");
    if (toolResults.length) {
      for (const item of toolResults) {
        result.push({
          role: "tool",
          tool_call_id: item.tool_use_id,
          content: typeof item.content === "string" ? item.content : JSON.stringify(item.content),
        });
      }
      continue;
    }

    result.push({
      role: message.role,
      content: JSON.stringify(content),
    });
  }

  return result;
}

function normalizeOpenAIToolChoice(toolChoice?: Record<string, any>) {
  if (!toolChoice) return "auto";
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "none") return "none";
  return "auto";
}

function safeJsonParse(input: string) {
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}
