import type { SessionRouteContext } from "./types.js";

export class SessionRouter {
  resolveSessionKey(context: SessionRouteContext) {
    const tenant = sanitize(context.tenantId || "default");
    const user = sanitize(context.userId || "anonymous");
    const channel = sanitize(context.channel || "general");

    if (context.businessObjectType && context.businessObjectId) {
      return [
        tenant,
        user,
        channel,
        sanitize(context.businessObjectType),
        sanitize(context.businessObjectId),
      ].join(":");
    }

    return [tenant, user, channel, "general"].join(":");
  }
}

function sanitize(value: string) {
  return value.trim().replace(/[:\s]+/g, "-") || "unknown";
}
