# =============================================================================
# ThothAgent — 多阶段构建
# =============================================================================

# ---- Stage 1: Build ----
FROM node:22-alpine AS builder

WORKDIR /build

# 依赖缓存层（docker layer caching）
COPY package.json package-lock.json ./
RUN npm ci

# 源码 + 编译
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# 产出：dist/ + node_modules（prod）

# ---- Stage 2: Runtime ----
FROM node:22-alpine AS runtime

# 安全：非 root 用户运行
RUN addgroup -S thothagent && adduser -S thothagent -G thothagent

WORKDIR /app

# 仅复制生产依赖
COPY --from=builder /build/node_modules node_modules/
COPY --from=builder /build/dist dist/
COPY --from=builder /build/package.json ./

# 数据目录（由 docker-compose volume 挂载）
RUN mkdir -p /data && chown thothagent:thothagent /data

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:${PORT:-18889}/health', r => r.statusCode === 200 ? process.exit(0) : process.exit(1)).on('error', () => process.exit(1))"

USER thothagent

ENV \
  THOTH_AGENT_HOME_ROOT=/data \
  THOTH_AGENT_GATEWAY_HOST=0.0.0.0 \
  THOTH_AGENT_GATEWAY_PORT=18889

EXPOSE 18889

ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "dist/gateway/start.js"]
