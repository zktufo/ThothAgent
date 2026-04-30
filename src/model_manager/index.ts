/**
 * ModelManager owns model/provider configuration.
 *
 * Responsibilities:
 * - load/save `~/.PetAgent/PetAgent.json`
 * - resolve primary/fallback model route for the current agent
 * - instantiate provider clients from config
 * - provide CLI-friendly read/update helpers
 */
import fs from "fs";
import { resolveUserHomePaths, type UserHomePaths } from "../home/index.js";
import {
  type LLMProvider,
  AnthropicCompatibleLLM,
  OpenAICompatibleLLM,
  type ProviderSettings,
} from "../llm/index.js";

export interface ModelDescriptor {
  id: string;
  name: string;
  api?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProviderOAuthConfig {
  enabled?: boolean;
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
  accountLabel?: string;
  authorizedAt?: string;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  api: string;
  models: ModelDescriptor[];
  authMethod?: "apiKey" | "oauth";
  oauth?: ProviderOAuthConfig;
}

export interface AgentModelConfig {
  primary: string;
  fallbacks?: string[];
}

export interface PetAgentConfig {
  meta?: Record<string, any>;
  models: {
    mode?: string;
    providers: Record<string, ProviderConfig>;
  };
  agents: {
    defaults: {
      model: AgentModelConfig;
      workspace?: string;
      compaction?: Record<string, any>;
    };
    list?: Array<{
      id: string;
      name?: string;
      workspace?: string;
      agentDir?: string;
      model?: AgentModelConfig;
    }>;
  };
}

export class ModelManager {
  readonly homePaths: UserHomePaths;
  readonly configPath: string;

  constructor(options: { homePaths?: UserHomePaths } = {}) {
    this.homePaths = options.homePaths || resolveUserHomePaths();
    this.configPath = this.homePaths.petAgentConfigPath;
  }

  loadConfig(): PetAgentConfig {
    return JSON.parse(fs.readFileSync(this.configPath, "utf-8")) as PetAgentConfig;
  }

  saveConfig(config: PetAgentConfig) {
    fs.writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  }

  getAgentModelConfig(agentId: string = this.homePaths.agentName) {
    const config = this.loadConfig();
    const agent = config.agents.list?.find((item) => item.id === agentId);
    return agent?.model || config.agents.defaults.model;
  }

  listModels() {
    const config = this.loadConfig();
    return Object.entries(config.models.providers).flatMap(([providerName, provider]) =>
      provider.models.map((model) => ({
        route: `${providerName}/${model.id}`,
        provider: providerName,
        modelId: model.id,
        modelName: model.name,
        api: model.api || provider.api,
        baseUrl: provider.baseUrl,
        configured: Boolean(resolveProviderCredential(provider)),
        authMethod: provider.authMethod || (provider.oauth?.accessToken ? "oauth" : provider.apiKey ? "apiKey" : "apiKey"),
      })),
    );
  }

  getConfiguredProviders(agentId: string = this.homePaths.agentName) {
    const route = this.getAgentModelConfig(agentId);
    const candidates = [route.primary, ...(route.fallbacks || [])];
    return candidates
      .map((candidate) => this.instantiateRoute(candidate))
      .filter((provider): provider is LLMProvider => provider !== null);
  }

  setPrimaryModel(route: string, agentId: string = this.homePaths.agentName) {
    const config = this.loadConfig();
    const target = ensureAgentConfig(config, agentId);
    target.model = target.model || { ...config.agents.defaults.model };
    target.model.primary = route;
    touchMeta(config);
    this.saveConfig(config);
  }

  setFallbackModels(routes: string[], agentId: string = this.homePaths.agentName) {
    const config = this.loadConfig();
    const target = ensureAgentConfig(config, agentId);
    target.model = target.model || { ...config.agents.defaults.model };
    target.model.fallbacks = routes;
    touchMeta(config);
    this.saveConfig(config);
  }

  updateProviderApiKey(providerName: string, apiKey: string) {
    const config = this.loadConfig();
    const provider = config.models.providers[providerName];
    if (!provider) throw new Error(`Unknown provider: ${providerName}`);
    provider.apiKey = apiKey;
    provider.authMethod = "apiKey";
    touchMeta(config);
    this.saveConfig(config);
  }

  updateProviderOAuth(providerName: string, oauth: ProviderOAuthConfig) {
    const config = this.loadConfig();
    const provider = config.models.providers[providerName];
    if (!provider) throw new Error(`Unknown provider: ${providerName}`);
    provider.oauth = {
      ...(provider.oauth || {}),
      ...oauth,
      enabled: true,
      authorizedAt: oauth.authorizedAt || new Date().toISOString(),
    };
    provider.authMethod = "oauth";
    touchMeta(config);
    this.saveConfig(config);
  }

  getProviderConfig(providerName: string) {
    const config = this.loadConfig();
    const provider = config.models.providers[providerName];
    if (!provider) {
      throw new Error(`Unknown provider: ${providerName}`);
    }
    return provider;
  }

  private instantiateRoute(route: string): LLMProvider | null {
    const [providerName, modelId] = route.split("/", 2);
    if (!providerName || !modelId) return null;

    const config = this.loadConfig();
    const provider = config.models.providers[providerName];
    if (!provider) return null;
    const model = provider.models.find((item) => item.id === modelId);
    if (!model) return null;

    const settings: ProviderSettings = {
      name: providerName,
      model: model.id,
      baseUrl: provider.baseUrl,
      apiKey: resolveProviderCredential(provider),
    };

    const api = model.api || provider.api;
    if (api === "anthropic-messages") {
      return new AnthropicCompatibleLLM(settings);
    }
    return new OpenAICompatibleLLM(settings);
  }
}

function resolveProviderCredential(provider: ProviderConfig) {
  if (provider.authMethod === "oauth") {
    return provider.oauth?.accessToken || "";
  }
  return provider.apiKey || provider.oauth?.accessToken || "";
}

function ensureAgentConfig(config: PetAgentConfig, agentId: string) {
  config.agents.list = config.agents.list || [];
  let agent = config.agents.list.find((item) => item.id === agentId);
  if (!agent) {
    agent = {
      id: agentId,
      name: agentId,
      model: { ...config.agents.defaults.model },
    };
    config.agents.list.push(agent);
  }
  return agent;
}

function touchMeta(config: PetAgentConfig) {
  config.meta = {
    ...(config.meta || {}),
    lastTouchedAt: new Date().toISOString(),
  };
}
