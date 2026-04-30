# OAuth Device Flow Integration

这是一套完整的 OAuth Device Authorization Grant (RFC 8628) 实现，专门为 CLI 应用设计。

## 概述

OAuth Device Flow 是一种标准的 OAuth 2.0 流程，特别适合没有 Web 服务器的命令行工具：

1. **应用请求设备码** → Provider 返回设备码和用户码
2. **用户验证** → 用户在浏览器中打开链接，输入用户码进行授权
3. **轮询授权状态** → 应用不断轮询直到用户完成授权或超时
4. **获取令牌** → 授权完成后获取 access token 和 refresh token

## 架构

### 核心模块

```
src/oauth/
├── types.ts              # 接口定义和类型
├── device_flow.ts        # OAuth Device Flow 实现
├── providers.ts          # Provider 配置（OpenAI, Minimax, DeepSeek）
├── index.ts              # 模块导出
└── basic_test.ts         # 测试脚本
```

### 核心类

**`OAuthDeviceFlow`** - 主要 OAuth 实现
```typescript
// 初始化
const flow = new OAuthDeviceFlow(config, callbacks);

// 执行流程
const tokenResponse = await flow.authenticate();

// 取消流程
flow.cancel();

// 获取状态
const state = flow.getState();
```

## 使用方式

### 1. 配置 OAuth 凭证

创建 OAuth 应用并获取 Client ID 和 Secret，然后设置环境变量：

```bash
# OpenAI
export OPENAI_OAUTH_CLIENT_ID="your-client-id"
export OPENAI_OAUTH_CLIENT_SECRET="your-client-secret"

# Minimax
export MINIMAX_OAUTH_CLIENT_ID="your-client-id"
export MINIMAX_OAUTH_CLIENT_SECRET="your-client-secret"

# DeepSeek
export DEEPSEEK_OAUTH_CLIENT_ID="your-client-id"
export DEEPSEEK_OAUTH_CLIENT_SECRET="your-client-secret"
```

### 2. 在 CLI 中使用

现在 CLI 提供三种授权方式：

```
选择授权方式
  • API Key                    - 直接使用 API Key
  • OAuth Device Flow          - 浏览器授权（自动打开）
  • OAuth Manual               - 手动输入 Token
```

选择 "OAuth Device Flow" 时：
1. 自动打开浏览器到授权页面
2. 显示用户码供手动输入
3. 自动轮询等待授权
4. 授权完成后自动保存 token

### 3. 程序中使用

```typescript
import { OAuthDeviceFlow, getOAuthProviderConfig } from "./oauth/index.js";

const config = getOAuthProviderConfig("openai");

const flow = new OAuthDeviceFlow(config, {
  onDeviceCode: (userCode, verificationUri, expiresIn) => {
    console.log(`Please visit: ${verificationUri}`);
    console.log(`Enter code: ${userCode}`);
  },
  onPoll: (attemptCount) => {
    console.log(`Polling... attempt ${attemptCount}`);
  },
  onSuccess: (token) => {
    console.log(`Access token: ${token.access_token}`);
  },
  onError: (error) => {
    console.error(`Error: ${error}`);
  },
});

try {
  const token = await flow.authenticate();
  // 使用 token
} catch (error) {
  // 处理错误
}
```

## 工作流程详解

### 第 1 步：请求设备码

应用向 Provider 的 `deviceFlowEndpoint` 发送请求：

```http
POST /oauth/device
Content-Type: application/x-www-form-urlencoded

client_id=xxx&scope=models.read+chat.create
```

Provider 返回：

```json
{
  "device_code": "ABC123...",
  "user_code": "WXYZ",
  "verification_uri": "https://provider.com/device",
  "expires_in": 1800,
  "interval": 5
}
```

### 第 2 步：用户授权

1. 自动打开浏览器到 `verification_uri`
2. 用户输入 `user_code`
3. 用户点击"授权"按钮

### 第 3 步：轮询令牌

应用每隔 `interval` 秒向 `tokenEndpoint` 发送请求：

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

client_id=xxx&client_secret=xxx&device_code=ABC123...&grant_type=urn:ietf:params:oauth:grant-type:device_code
```

可能的响应：

**授权待处理**（继续轮询）：
```json
{
  "error": "authorization_pending"
}
```

**授权成功**（返回令牌）：
```json
{
  "access_token": "...",
  "refresh_token": "...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

**授权拒绝/过期**（停止轮询）：
```json
{
  "error": "expired_token"
}
```

## 测试

```bash
# 构建
npm run build

# 运行测试
OPENAI_OAUTH_CLIENT_ID=xxx OPENAI_OAUTH_CLIENT_SECRET=xxx \
node dist/oauth/basic_test.js openai
```

## 后续扩展

### 1. Refresh Token 处理

实现自动刷新 expired tokens：

```typescript
async refreshAccessToken(refreshToken: string): Promise<TokenResponse>
```

### 2. Token 存储与恢复

在本地安全存储 refresh token，应用启动时自动恢复：

```typescript
class TokenManager {
  saveToken(provider: string, token: TokenResponse): void
  loadToken(provider: string): TokenResponse | null
  refreshIfNeeded(provider: string): Promise<TokenResponse>
}
```

### 3. 多账户支持

允许用户关联多个 OAuth 账户到同一个 Provider：

```typescript
interface AccountBinding {
  provider: string
  accountId: string
  tokens: TokenResponse
  metadata?: Record<string, any>
}
```

### 4. PKCE 支持

添加 Proof Key for Public Clients (PKCE) 以增强安全性。

## 错误处理

常见错误及处理策略：

| 错误 | 含义 | 处理 |
|------|------|------|
| `authorization_pending` | 用户还未授权 | 继续轮询 |
| `slow_down` | 轮询过频 | 增加轮询间隔 |
| `expired_token` | 设备码已过期 | 重新开始流程 |
| `access_denied` | 用户拒绝 | 提示用户重试 |
| `invalid_client` | Client ID/Secret 错误 | 检查配置 |

## 安全考虑

1. **不在日志中输出 Token** - 仅在必要时输出 Token 的前几个字符
2. **设置合理的过期时间** - 默认 30 分钟
3. **使用 HTTPS** - 所有通信都应使用 HTTPS
4. **不在命令行参数中传递敏感信息** - 使用环境变量或配置文件
5. **定期刷新 Token** - 使用 refresh token 获取新的 access token

## 参考

- [RFC 8628 - OAuth 2.0 Device Authorization Grant](https://tools.ietf.org/html/rfc8628)
- [OpenAI OAuth Documentation](https://platform.openai.com/docs/guides/oauth)
- [OAuth 2.0 Security Best Practices](https://tools.ietf.org/html/draft-ietf-oauth-security-topics)
