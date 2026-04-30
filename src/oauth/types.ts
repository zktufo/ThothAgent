/**
 * OAuth Device Flow types and interfaces
 */

export interface DeviceFlowRequest {
  client_id: string;
  scope: string;
}

export interface DeviceFlowResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number; // seconds between polls
}

export interface TokenRequest {
  client_id: string;
  client_secret: string;
  device_code: string;
  grant_type: "urn:ietf:params:oauth:grant-type:device_code";
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export interface OAuthProviderConfig {
  provider: string; // openai, minimax, deepseek, etc.
  clientId: string;
  clientSecret: string;
  deviceFlowEndpoint: string;
  tokenEndpoint: string;
  scope: string;
  redirectUri?: string; // for web-based flow (backup)
}

export interface OAuthFlowState {
  status: "pending" | "authorized" | "expired" | "cancelled";
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  expiresAt?: number;
  pollInterval?: number;
  error?: string;
}

export interface OAuthFlowCallbacks {
  onDeviceCode?: (userCode: string, verificationUri: string, expiresIn: number) => void;
  onPoll?: (attemptCount: number) => void;
  onSuccess?: (token: TokenResponse) => void;
  onError?: (error: string) => void;
  onCancel?: () => void;
}
