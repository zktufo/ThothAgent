/**
 * OAuth Device Flow implementation
 *
 * Implements OAuth 2.0 Device Authorization Grant (RFC 8628)
 * Suitable for CLI applications without browser integration.
 */
import { exec } from "child_process";
import type {
  OAuthProviderConfig,
  OAuthFlowState,
  OAuthFlowCallbacks,
  DeviceFlowResponse,
  TokenResponse,
} from "./types.js";

export class OAuthDeviceFlow {
  private config: OAuthProviderConfig;
  private state: OAuthFlowState = { status: "pending" };
  private callbacks: OAuthFlowCallbacks;
  private abortController: AbortController | null = null;

  constructor(config: OAuthProviderConfig, callbacks: OAuthFlowCallbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
  }

  /**
   * Start the OAuth device flow
   */
  async authenticate(): Promise<TokenResponse> {
    try {
      // Step 1: Request device code
      const deviceFlowResponse = await this.requestDeviceCode();
      this.state = {
        status: "pending",
        deviceCode: deviceFlowResponse.device_code,
        userCode: deviceFlowResponse.user_code,
        verificationUri: deviceFlowResponse.verification_uri,
        expiresAt: Date.now() + deviceFlowResponse.expires_in * 1000,
        pollInterval: (deviceFlowResponse.interval || 5) * 1000, // convert to milliseconds
      };

      // Step 2: Display device code and URI to user
      if (this.callbacks.onDeviceCode) {
        this.callbacks.onDeviceCode(
          deviceFlowResponse.user_code,
          deviceFlowResponse.verification_uri,
          deviceFlowResponse.expires_in,
        );
      }

      // Step 3: Open browser automatically (optional)
      if (process.env.OAUTH_AUTO_OPEN_BROWSER !== "false") {
        this.openBrowserUrl(deviceFlowResponse.verification_uri);
      }

      // Step 4: Poll for token
      const tokenResponse = await this.pollForToken();

      this.state.status = "authorized";
      if (this.callbacks.onSuccess) {
        this.callbacks.onSuccess(tokenResponse);
      }

      return tokenResponse;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.state.status = "expired";
      this.state.error = errorMsg;
      if (this.callbacks.onError) {
        this.callbacks.onError(errorMsg);
      }
      throw error;
    }
  }

  /**
   * Cancel ongoing flow
   */
  cancel() {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.state.status = "cancelled";
    if (this.callbacks.onCancel) {
      this.callbacks.onCancel();
    }
  }

  /**
   * Get current state
   */
  getState(): OAuthFlowState {
    return { ...this.state };
  }

  /**
   * Request device code from provider
   */
  private async requestDeviceCode(): Promise<DeviceFlowResponse> {
    const response = await fetch(this.config.deviceFlowEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        scope: this.config.scope,
      }).toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Device code request failed: ${response.status} - ${error}`,
      );
    }

    return response.json();
  }

  /**
   * Poll for token with exponential backoff
   */
  private async pollForToken(): Promise<TokenResponse> {
    if (!this.state.deviceCode || !this.state.expiresAt || !this.state.pollInterval) {
      throw new Error("Invalid device flow state");
    }

    this.abortController = new AbortController();
    let attemptCount = 0;
    const maxAttempts = Math.ceil((this.state.expiresAt - Date.now()) / this.state.pollInterval) + 5; // safety margin

    while (attemptCount < maxAttempts) {
      if (this.abortController.signal.aborted) {
        throw new Error("OAuth flow cancelled");
      }

      // Check if flow expired
      if (Date.now() > this.state.expiresAt) {
        throw new Error("Device code expired");
      }

      // Wait before polling (except first attempt)
      if (attemptCount > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.state.pollInterval!),
        );
      }

      attemptCount++;
      if (this.callbacks.onPoll) {
        this.callbacks.onPoll(attemptCount);
      }

      try {
        const tokenResponse = await this.requestToken();
        return tokenResponse;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Authorization pending - normal during polling
        if (errorMsg.includes("authorization_pending")) {
          continue;
        }

        // Other errors should be thrown
        throw error;
      }
    }

    throw new Error("Device code polling timeout");
  }

  /**
   * Request token from provider
   */
  private async requestToken(): Promise<TokenResponse> {
    const response = await fetch(this.config.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        device_code: this.state.deviceCode!,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Token request failed: ${errorData.error || response.statusText}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(`OAuth error: ${data.error}`);
    }

    return data;
  }

  /**
   * Open browser URL (platform-specific)
   */
  private openBrowserUrl(url: string) {
    let command: string;

    if (process.platform === "darwin") {
      command = `open "${url}"`;
    } else if (process.platform === "win32") {
      command = `start "${url}"`;
    } else {
      // Linux
      command = `xdg-open "${url}" > /dev/null 2>&1 &`;
    }

    try {
      exec(command);
    } catch {
      // Silently fail if browser cannot be opened
    }
  }
}
