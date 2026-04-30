/**
 * OAuth Device Flow - Basic Test
 *
 * Test the OAuth device flow implementation
 * 
 * Usage:
 *   npm run build
 *   OPENAI_OAUTH_CLIENT_ID=your-id OPENAI_OAUTH_CLIENT_SECRET=your-secret node dist/oauth/basic_test.js
 */
import { OAuthDeviceFlow, getOAuthProviderConfig, validateOAuthConfig } from "./index.js";

async function main() {
  const provider = process.argv[2] || "openai";

  console.log(`\n🔐 OAuth Device Flow Test - ${provider}\n`);

  try {
    const config = getOAuthProviderConfig(provider);

    const isValid = validateOAuthConfig(config);
    if (!isValid) {
      console.warn(
        `⚠ OAuth configuration for ${provider} is incomplete.\n` +
        `Please set environment variables:\n` +
        `  ${provider.toUpperCase()}_OAUTH_CLIENT_ID\n` +
        `  ${provider.toUpperCase()}_OAUTH_CLIENT_SECRET\n`
      );
      return;
    }

    console.log(`✓ OAuth configuration loaded for ${provider}\n`);
    console.log(`Device endpoint: ${config.deviceFlowEndpoint}`);
    console.log(`Token endpoint: ${config.tokenEndpoint}`);
    console.log(`Scope: ${config.scope}\n`);

    const flow = new OAuthDeviceFlow(config, {
      onDeviceCode: (userCode, verificationUri, expiresIn) => {
        console.log(`✓ Device code generated\n`);
        console.log(`User Code: ${userCode}`);
        console.log(`Authorization URL: ${verificationUri}`);
        console.log(`Expires in: ${expiresIn} seconds\n`);
        console.log(`Polling for authorization...`);
      },
      onPoll: (attemptCount) => {
        if (attemptCount % 3 === 0) {
          process.stdout.write(".");
        }
      },
      onSuccess: (token) => {
        console.log(`\n\n✓ Authorization successful!\n`);
        console.log(`Access Token: ${token.access_token.slice(0, 20)}...`);
        console.log(`Token Type: ${token.token_type}`);
        console.log(`Expires In: ${token.expires_in} seconds`);
        if (token.refresh_token) {
          console.log(`Refresh Token: ${token.refresh_token.slice(0, 20)}...`);
        }
      },
      onError: (error) => {
        console.error(`\n✗ Authorization failed: ${error}`);
      },
    });

    const token = await flow.authenticate();
    console.log("\n✓ Test completed successfully!");
  } catch (error) {
    console.error(`✗ Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
