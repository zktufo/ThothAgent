#!/usr/bin/env node
/**
 * pet-agent Gateway Server — 独立生产入口
 *
 * Docker 部署使用此入口直接启动 Gateway，不经过 CLI。
 * 所有配置通过环境变量注入。
 */

import { ensureUserHomeReady } from "../home/index.js";
import { PetGateway } from "./index.js";

async function main() {
  await ensureUserHomeReady();

  const host = process.env.PET_AGENT_GATEWAY_HOST || "0.0.0.0";
  const port = parseInt(process.env.PET_AGENT_GATEWAY_PORT || "18889", 10);

  const gateway = await PetGateway.create({
    host,
    port,
  });

  gateway.start();
}

main().catch((err) => {
  console.error("[petagent] Gateway failed to start:", err);
  process.exit(1);
});
