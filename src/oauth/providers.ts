/**
 * OAuth Provider configurations for common LLM providers
 */
import type { OAuthProviderConfig } from "./types.js";

export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  openai: {
    provider: "openai",
    clientId: process.env.OPENAI_OAUTH_CLIENT_ID || "your-client-id",
    clientSecret: process.env.OPENAI_OAUTH_CLIENT_SECRET || "your-client-secret",
    deviceFlowEndpoint: "https://auth.openai.com/oauth/device",
    tokenEndpoint: "https://auth.openai.com/oauth/token",
    scope: "openai-org:models.read openai-org:models.create",
    redirectUri: "http://localhost:3000/oauth/callback",
  },
  minimax: {
    provider: "minimax",
    clientId: process.env.MINIMAX_OAUTH_CLIENT_ID || "your-client-id",
    clientSecret: process.env.MINIMAX_OAUTH_CLIENT_SECRET || "your-client-secret",
    deviceFlowEndpoint: "https://api.minimaxi.com/oauth/device",
    tokenEndpoint: "https://api.minimaxi.com/oauth/token",
    scope: "model.read model.chat",
  },
  deepseek: {
    provider: "deepseek",
    clientId: process.env.DEEPSEEK_OAUTH_CLIENT_ID || "your-client-id",
    clientSecret: process.env.DEEPSEEK_OAUTH_CLIENT_SECRET || "your-client-secret",
    deviceFlowEndpoint: "https://api.deepseek.com/oauth/device",
    tokenEndpoint: "https://api.deepseek.com/oauth/token",
    scope: "models.read chat.create",
  },
};

export function getOAuthProviderConfig(provider: string): OAuthProviderConfig {
  const config = OAUTH_PROVIDERS[provider.toLowerCase()];
  if (!config) {
    throw new Error(`Unknown OAuth provider: ${provider}`);
  }
  return config;
}

export function validateOAuthConfig(config: OAuthProviderConfig): boolean {
  return (
    Boolean(config.clientId && config.clientId !== "your-client-id") &&
    Boolean(config.clientSecret && config.clientSecret !== "your-client-secret") &&
    Boolean(config.deviceFlowEndpoint) &&
    Boolean(config.tokenEndpoint) &&
    Boolean(config.scope)
  );
}
