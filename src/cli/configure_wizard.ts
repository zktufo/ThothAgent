/**
 * Model provider configuration wizard.
 *
 * Interactive CLI that walks the user through:
 *   1. Pick a provider company
 *   2. Choose auth method (API Key / OAuth)
 *   3. Authorize → fetch available models → user selects → save
 *
 * The UX matches the Inquirer / @clack/prompts style shown in the design spec.
 */
import * as p from "@clack/prompts";
import { execSync } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import { ModelManager } from "../model_manager/index.js";
import type { PetAgentConfig, ProviderConfig } from "../model_manager/index.js";
import { OAuthDeviceFlow, getOAuthProviderConfig, validateOAuthConfig } from "../oauth/index.js";
import { PROVIDER_CATALOG, findProviderByKey } from "./providers_catalog.js";

export interface ConfigureResult {
  providerKey: string;
  authMethod: "apiKey" | "oauth";
  modelsAdded: string[];
  primaryModel: string;
  fallbackModels: string[];
}

/**
 * Entry point: run the full provider configuration wizard.
 */
export async function runConfigureWizard(modelManager: ModelManager, agentName: string): Promise<ConfigureResult> {
  p.intro("🐶 配置 Model Provider");

  // ─── Level 1: 选择供应商 ─────────────────────────────────
  const providerKey = await selectProvider();
  if (p.isCancel(providerKey)) {
    p.cancel("配置已取消");
    process.exit(0);
  }

  const entry = findProviderByKey(providerKey);
  if (!entry) {
    p.cancel(`未知供应商: ${providerKey}`);
    process.exit(0);
  }

  p.log.step(`已选择: ${entry.label} (${entry.subtitle})`);

  // ─── Level 2: 选择认证方式 ────────────────────────────────
  const authMethods: Array<{ label: string; description: string; value: "apiKey" | "oauth" }> = [
    { label: "API Key", description: `${entry.keyHint}`, value: "apiKey" },
  ];
  if (entry.supportsOAuth) {
    authMethods.push({
      label: "OAuth 授权",
      description: "通过浏览器授权，自动获取可用模型列表",
      value: "oauth",
    });
  }

  const authMethod = await p.select({
    message: "选择接入方式",
    options: authMethods,
  });
  if (p.isCancel(authMethod)) {
    p.cancel("配置已取消");
    process.exit(0);
  }

  // ─── Level 3: 认证 + 拉模型列表 ──────────────────────────
  let credential: { method: "apiKey"; key: string } | { method: "oauth"; accessToken: string; refreshToken?: string };

  if (authMethod === "apiKey") {
    credential = await handleApiKeyFlow(entry.key, entry.keyHint);
  } else {
    credential = await handleOAuthFlow(entry);
  }

  // ─── 获取可用模型 ─────────────────────────────────────────
  const availableModels = await discoverModels(entry, credential);
  if (p.isCancel(availableModels)) {
    p.cancel("配置已取消");
    process.exit(0);
  }

  // ─── 用户选择要接入的模型 ─────────────────────────────────
  const selectedModels = await selectModels(availableModels);
  if (p.isCancel(selectedModels)) {
    p.cancel("配置已取消");
    process.exit(0);
  }

  if (selectedModels.length === 0) {
    p.cancel("至少选择一个模型");
    process.exit(0);
  }

  // ─── 选择主模型 ───────────────────────────────────────────
  const primaryModel = selectedModels.length === 1
    ? selectedModels[0]
    : await p.select({
        message: "选择主模型（primary）",
        options: selectedModels.map((m) => ({ label: m, value: m })),
      });
  if (p.isCancel(primaryModel)) {
    p.cancel("配置已取消");
    process.exit(0);
  }

  const fallbackModels = selectedModels.filter((m) => m !== primaryModel);

  // ─── 保存到 PetAgent.json ─────────────────────────────────
  saveProviderConfig(modelManager, entry, credential, selectedModels, primaryModel, fallbackModels);

  p.outro(`✅ ${entry.label} 配置完成！主模型: ${primaryModel}`);
  return {
    providerKey: entry.key,
    authMethod,
    modelsAdded: selectedModels,
    primaryModel,
    fallbackModels,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 内部步骤
// ═══════════════════════════════════════════════════════════════════════════

async function selectProvider() {
  return p.select({
    message: "选择 AI 模型供应商",
    options: PROVIDER_CATALOG.map((entry) => ({
      label: entry.label,
      hint: entry.subtitle,
      value: entry.key,
    })),
  });
}

async function handleApiKeyFlow(providerKey: string, keyHint: string): Promise<{ method: "apiKey"; key: string }> {
  p.log.message(keyHint);

  const apiKey = await p.password({
    message: "输入 API Key",
    validate: (input) => {
      if (!input || input.trim().length < 8) return "API Key 长度不足，请检查";
    },
  });
  if (p.isCancel(apiKey)) {
    p.cancel("配置已取消");
    process.exit(0);
  }

  return { method: "apiKey", key: apiKey.trim() };
}

/**
 * Map catalog keys to OAuth provider keys.
 *
 * The catalog uses config-friendly keys like "minimax-portal" while the
 * OAuth module uses shorter keys like "minimax". This bridge handles the
 * mismatch so users don't have to think about internal key naming.
 */
const CATALOG_KEY_TO_OAUTH_KEY: Record<string, string> = {
  "minimax-portal": "minimax",
  "deepseek": "deepseek",
  "openai": "openai",
};

const CATALOG_KEY_TO_ENV_PREFIX: Record<string, string> = {
  "minimax-portal": "MINIMAX",
  "deepseek": "DEEPSEEK",
  "openai": "OPENAI",
};

function resolveOAuthProviderKey(catalogKey: string): string {
  return CATALOG_KEY_TO_OAUTH_KEY[catalogKey] || catalogKey;
}

function resolveEnvPrefix(catalogKey: string): string {
  return CATALOG_KEY_TO_ENV_PREFIX[catalogKey] || catalogKey.toUpperCase().replace(/-/g, "_");
}

async function handleOAuthFlow(entry: import("./providers_catalog.js").ProviderCatalogEntry) {
  const oauthProviderKey = resolveOAuthProviderKey(entry.key);
  const oauthConfig = getOAuthProviderConfig(oauthProviderKey);
  const isOAuthConfigured = validateOAuthConfig(oauthConfig);

  if (!isOAuthConfigured) {
    const envPrefix = resolveEnvPrefix(entry.key);
    p.log.warn(
      `⚠ ${entry.label} 的 OAuth 环境变量未配置。\n` +
      `如需使用 OAuth，请设置:\n` +
      `  ${envPrefix}_OAUTH_CLIENT_ID\n` +
      `  ${envPrefix}_OAUTH_CLIENT_SECRET\n`
    );

    const fallbackMethod = await p.select({
      message: `无法使用 OAuth，请选择替代方式`,
      options: [
        { label: "输入 API Key", value: "apiKey" },
        { label: "取消配置", value: "cancel" },
      ],
    });
    if (p.isCancel(fallbackMethod) || fallbackMethod === "cancel") {
      p.cancel("配置已取消");
      process.exit(0);
    }

    return handleApiKeyFlow(entry.key, entry.keyHint);
  }

  // OAuth Device Flow
  p.log.step(`正在通过浏览器授权 ${entry.label}...`);

  const flow = new OAuthDeviceFlow(oauthConfig, {
    onDeviceCode: (userCode, verificationUri, expiresIn) => {
      p.note(
        `用户码: ${userCode}\n授权链接: ${verificationUri}\n有效期: ${expiresIn} 秒`,
        "请打开浏览器完成授权"
      );
      // 自动打开授权链接到默认浏览器
      try {
        execSync(`open "${verificationUri}"`, { timeout: 3000 });
      } catch {
        p.log.info(`如果浏览器没有自动打开，请手动访问: ${verificationUri}`);
      }
    },
    onPoll: () => {
      // spinner handles the animation
    },
    onSuccess: (token) => {
      p.log.success("OAuth 授权成功！");
    },
    onError: (error) => {
      p.log.error(`OAuth 失败: ${error}`);
    },
  });

  const s = p.spinner();
  s.start("等待授权...");

  try {
    const token = await flow.authenticate();
    s.stop("授权完成");
    return {
      method: "oauth" as const,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
    };
  } catch (error) {
    s.stop("授权失败");
    throw error;
  }
}

async function discoverModels(
  entry: import("./providers_catalog.js").ProviderCatalogEntry,
  credential: { method: "apiKey"; key: string } | { method: "oauth"; accessToken: string; refreshToken?: string },
) {
  const s = p.spinner();
  s.start("获取可用模型列表...");

  try {
    // 先尝试从 API 实时拉取模型列表
    let discoveredModels: string[] = [];

    if (entry.modelsEndpoint) {
      try {
        const token = credential.method === "apiKey" ? credential.key : credential.accessToken;
        const headers: Record<string, string> = {
          ...(entry.api === "anthropic-messages"
            ? { "x-api-key": token, "anthropic-version": "2023-06-01" }
            : { Authorization: `Bearer ${token}` }),
        };

        const response = await fetch(entry.modelsEndpoint, { headers });
        if (response.ok) {
          const body = await response.json() as any;
          discoveredModels = extractModelIds(body, entry.api);
        }
      } catch {
        // fallthrough: fall back to catalog
      }
    }

    // Fallback: use known models from catalog
    if (!discoveredModels.length) {
      discoveredModels = entry.knownModels.map((m) => m.id);
      s.message("使用内置模型列表 (API 列表不可用)");
      await sleep(600);
    }

    s.stop(`发现 ${discoveredModels.length} 个可用模型`);
    return discoveredModels;
  } catch (error) {
    s.stop("获取模型列表失败");
    p.log.error(`获取模型列表失败: ${error}`);
    // fallback to catalog
    const fallback = entry.knownModels.map((m) => m.id);
    p.log.info(`使用内置模型列表: ${fallback.join(", ")}`);
    return fallback;
  }
}

async function selectModels(availableModels: string[]) {
  return p.multiselect({
    message: "选择要接入的模型",
    required: true,
    options: availableModels.map((modelId) => ({
      label: modelId,
      value: modelId,
    })),
  });
}

function extractModelIds(apiResponse: any, apiFormat: string): string[] {
  try {
    // OpenAI-compatible: { data: [{ id: "gpt-4", ... }] }
    if (apiFormat === "openai-completions" && Array.isArray(apiResponse.data)) {
      return apiResponse.data.map((m: any) => m.id).filter(Boolean);
    }
    // Anthropic-compatible: { data: [{ type: "model", id: "claude-opus-4-7" }] }
    if (apiFormat === "anthropic-messages" && Array.isArray(apiResponse.data)) {
      return apiResponse.data
        .filter((m: any) => m.type === "model")
        .map((m: any) => m.id).filter(Boolean);
    }
  } catch {
    // ignore parse failures
  }
  return [];
}

function saveProviderConfig(
  modelManager: ModelManager,
  entry: import("./providers_catalog.js").ProviderCatalogEntry,
  credential: { method: "apiKey"; key: string } | { method: "oauth"; accessToken: string; refreshToken?: string },
  selectedModels: string[],
  primaryModel: string,
  fallbackModels: string[],
) {
  const config = modelManager.loadConfig();

  // 构建 provider config
  const modelsConfig = selectedModels.map((modelId) => {
    const known = entry.knownModels.find((m) => m.id === modelId);
    return {
      id: modelId,
      name: known?.name || modelId,
      api: entry.api,
      reasoning: known?.reasoning ?? false,
      input: ["text"],
      contextWindow: known?.contextWindow ?? 128_000,
      maxTokens: 8192,
    };
  });

  const providerConfig: ProviderConfig = {
    baseUrl: entry.baseUrl,
    api: entry.api,
    models: modelsConfig,
    authMethod: credential.method,
  };

  if (credential.method === "apiKey") {
    providerConfig.apiKey = credential.key;
    providerConfig.oauth = {
      enabled: false,
      accessToken: "",
      refreshToken: "",
    };
  } else {
    providerConfig.apiKey = "";
    providerConfig.oauth = {
      enabled: true,
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken || "",
      accountLabel: `oauth-${new Date().toISOString().slice(0, 10)}`,
      authorizedAt: new Date().toISOString(),
    };
    if (credential.refreshToken) {
      providerConfig.authMethod = "oauth";
    }
  }

  const configObj = config as PetAgentConfig;
  configObj.models.providers[entry.key] = providerConfig;

  // 更新 agent 的模型路由
  const agentConfig = ensureAgentRoute(configObj, modelManager.homePaths.agentName);
  agentConfig.model = {
    primary: `${entry.key}/${primaryModel}`,
    fallbacks: fallbackModels.map((m) => `${entry.key}/${m}`),
  };

  modelManager.saveConfig(configObj);
}

function ensureAgentRoute(config: PetAgentConfig, agentId: string): NonNullable<PetAgentConfig["agents"]["list"]>[number] {
  config.agents.list = config.agents.list || [];
  let entry = config.agents.list.find((a) => a.id === agentId);
  if (!entry) {
    entry = { id: agentId, name: agentId, model: { ...config.agents.defaults.model } };
    config.agents.list.push(entry);
  }
  return entry;
}

// ═══════════════════════════════════════════════════════════════════════════
// 高级配置子命令
// ═══════════════════════════════════════════════════════════════════════════

/**
 * petagent configure provider <key> --api-key <key>
 * 非交互式配置 API Key
 */
export function configureProviderWithApiKey(
  modelManager: ModelManager,
  providerKey: string,
  apiKey: string,
): void {
  const entry = findProviderByKey(providerKey);
  if (!entry) {
    throw new Error(`Unknown provider: ${providerKey}`);
  }

  saveProviderConfig(modelManager, entry, { method: "apiKey", key: apiKey }, entry.knownModels.map((m) => m.id), entry.knownModels[0]!.id, entry.knownModels.slice(1).map((m) => m.id));
}
