/**
 * Provider catalog — known AI model providers.
 *
 * Each entry carries enough metadata to:
 * - render a human-readable company name in selection screens
 * - auto-configure the base URL and API format
 * - let the user pick from known popular models
 * - serve as a starting point for model discovery
 */
export interface ProviderCatalogEntry {
  /** Stable config key (e.g. "alibaba", "openai") */
  key: string;
  /** Human-readable company / product name */
  label: string;
  /** Shorter subtitle shown in selection menus */
  subtitle: string;
  /** Base URL for API requests */
  baseUrl: string;
  /** API format that the wire protocol expects */
  api: "openai-completions" | "anthropic-messages";
  /** Known model slugs (displayed as suggestions, may be extended at runtime) */
  knownModels: Array<{ id: string; name: string; contextWindow: number; reasoning?: boolean }>;
  /** Whether OAuth device flow is feasible (requires client-id / secret) */
  supportsOAuth: boolean;
  /** API key hint shown in prompts */
  keyHint: string;
  /** Optional: a callable endpoint that lists available models after auth */
  modelsEndpoint?: string;
}

/**
 * Non-exhaustive catalog of popular providers.
 *
 * Extend this list as the ecosystem grows. Every new entry must have a unique
 * `key` that stays stable across config file versions.
 */
export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    key: "minimax-portal",
    label: "MiniMax",
    subtitle: "MiniMax大模型平台 (M2.7 / M2.5)",
    baseUrl: "https://api.minimaxi.com/anthropic",
    api: "anthropic-messages",
    knownModels: [
      { id: "MiniMax-M2.7", name: "MiniMax M2.7", contextWindow: 200_000, reasoning: true },
      { id: "MiniMax-M2.5", name: "MiniMax M2.5", contextWindow: 200_000, reasoning: false },
      { id: "MiniMax-M2.5-Lightning", name: "MiniMax M2.5 Lightning", contextWindow: 200_000, reasoning: false },
      { id: "MiniMax-T2.5", name: "MiniMax T2.5 (文本)", contextWindow: 200_000, reasoning: false },
    ],
    supportsOAuth: true,
    keyHint: "登录 MiniMax 官网 → 控制台 → API Keys → 创建新 Key",
    modelsEndpoint: "https://api.minimaxi.com/v1/models",
  },
  {
    key: "openai",
    label: "OpenAI",
    subtitle: "OpenAI Platform (GPT-5 / 4o)",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    knownModels: [
      { id: "gpt-5.5", name: "GPT-5.5", contextWindow: 200_000, reasoning: true },
      { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 200_000, reasoning: true },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128_000, reasoning: false },
      { id: "gpt-image-2", name: "GPT Image 2", contextWindow: 128_000, reasoning: false },
    ],
    supportsOAuth: true,
    keyHint: "登录 platform.openai.com → API Keys → 创建新的 Secret Key",
    modelsEndpoint: "https://api.openai.com/v1/models",
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    subtitle: "DeepSeek (V4 / Chat / Reasoner)",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    knownModels: [
      { id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 64_000, reasoning: false },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner", contextWindow: 64_000, reasoning: true },
    ],
    supportsOAuth: true,
    keyHint: "登录 platform.deepseek.com → API Keys → 创建 Key",
    modelsEndpoint: "https://api.deepseek.com/v1/models",
  },
  {
    key: "anthropic",
    label: "Anthropic",
    subtitle: "Anthropic API (Claude Opus / Sonnet / Haiku)",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    knownModels: [
      { id: "claude-opus-4-7", name: "Claude Opus 4.7", contextWindow: 200_000, reasoning: true },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextWindow: 200_000, reasoning: true },
      { id: "claude-haiku-5", name: "Claude Haiku 5", contextWindow: 200_000, reasoning: false },
      { id: "claude-3-5-sonnet-v2", name: "Claude 3.5 Sonnet v2", contextWindow: 200_000, reasoning: false },
    ],
    supportsOAuth: false,
    keyHint: "登录 console.anthropic.com → API Keys → 创建 Key",
  },
  {
    key: "alibaba",
    label: "Alibaba Model Studio",
    subtitle: "阿里云百炼 (DashScope / Qwen系列)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    knownModels: [
      { id: "qwen-max", name: "通义千问 Max", contextWindow: 32_000, reasoning: false },
      { id: "qwen-plus", name: "通义千问 Plus", contextWindow: 32_000, reasoning: false },
      { id: "qwen-turbo", name: "通义千问 Turbo", contextWindow: 32_000, reasoning: false },
      { id: "qwq-32b", name: "QwQ 32B (推理)", contextWindow: 32_000, reasoning: true },
    ],
    supportsOAuth: false,
    keyHint: "登录百炼控制台 → API-KEY 管理 → 创建 API Key",
  },
  {
    key: "google",
    label: "Google Gemini",
    subtitle: "Google AI Studio / Vertex AI (Gemini系列)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    api: "openai-completions",
    knownModels: [
      { id: "gemini-2-5-pro", name: "Gemini 2.5 Pro", contextWindow: 1_000_000, reasoning: true },
      { id: "gemini-2-5-flash", name: "Gemini 2.5 Flash", contextWindow: 1_000_000, reasoning: false },
      { id: "gemini-2-0-flash", name: "Gemini 2.0 Flash", contextWindow: 1_000_000, reasoning: false },
    ],
    supportsOAuth: false,
    keyHint: "登录 aistudio.google.com → Get API Key → 创建 Key",
  },
  {
    key: "moonshot",
    label: "Moonshot (Kimi)",
    subtitle: "月之暗面 Kimi (K2.5 / K1.5)",
    baseUrl: "https://api.moonshot.cn/v1",
    api: "openai-completions",
    knownModels: [
      { id: "kimi-k2.5", name: "Kimi K2.5", contextWindow: 128_000, reasoning: true },
      { id: "kimi-k1.5", name: "Kimi K1.5", contextWindow: 128_000, reasoning: false },
    ],
    supportsOAuth: false,
    keyHint: "登录 kimi.moonshot.cn → 开发者平台 → API Keys",
  },
  {
    key: "groq",
    label: "Groq",
    subtitle: "Groq Cloud (极速推理, LPU)",
    baseUrl: "https://api.groq.com/openai/v1",
    api: "openai-completions",
    knownModels: [
      { id: "llama-4-scout", name: "Llama 4 Scout", contextWindow: 128_000, reasoning: false },
      { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 100_000, reasoning: false },
      { id: "mixtral-8x7b", name: "Mixtral 8x7B", contextWindow: 32_000, reasoning: false },
    ],
    supportsOAuth: false,
    keyHint: "登录 console.groq.com → API Keys → 创建 Key",
  },
  {
    key: "siliconflow",
    label: "SiliconFlow",
    subtitle: "硅基流动 (开源模型平台)",
    baseUrl: "https://api.siliconflow.cn/v1",
    api: "openai-completions",
    knownModels: [
      { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 100_000, reasoning: false },
      { id: "qwen-max", name: "Qwen Max", contextWindow: 32_000, reasoning: false },
      { id: "llama-4-scout", name: "Llama 4 Scout", contextWindow: 128_000, reasoning: false },
    ],
    supportsOAuth: false,
    keyHint: "登录 cloud.siliconflow.cn → API 密钥 → 新建",
  },
  {
    key: "together",
    label: "Together AI",
    subtitle: "Together AI Cloud (开源模型)",
    baseUrl: "https://api.together.xyz/v1",
    api: "openai-completions",
    knownModels: [
      { id: "llama-4-scout", name: "Llama 4 Scout", contextWindow: 128_000, reasoning: false },
      { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 100_000, reasoning: false },
    ],
    supportsOAuth: false,
    keyHint: "登录 api.together.xyz → API Keys → 创建 Key",
  },
];

export function findProviderByKey(key: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.key === key);
}
