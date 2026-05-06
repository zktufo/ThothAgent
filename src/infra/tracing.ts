import { Logger } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";

export interface TraceSpanResult {
  ok: boolean;
  error?: unknown;
  data?: Record<string, unknown>;
}

export class TraceManager {
  constructor(
    private logger: Logger,
    private metrics: MetricsRegistry,
  ) {}

  async span<T>(
    name: string,
    fn: () => Promise<T>,
    attrs: Record<string, string> = {},
  ): Promise<T> {
    const startedAt = Date.now();
    this.logger.debug("trace.start", {
      span: name,
      attrs,
    });
    try {
      const result = await fn();
      const durationMs = Date.now() - startedAt;
      this.metrics.increment("trace_success_total", 1, { span: name, ...attrs });
      this.metrics.recordTimer("trace_duration_ms", durationMs, { span: name, ...attrs });
      this.logger.debug("trace.end", {
        span: name,
        attrs,
        ok: true,
        durationMs,
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      this.metrics.increment("trace_error_total", 1, { span: name, ...attrs });
      this.metrics.recordTimer("trace_duration_ms", durationMs, { span: name, ...attrs });
      this.logger.error("trace.end", error, {
        span: name,
        attrs,
        ok: false,
        durationMs,
      });
      throw error;
    }
  }
}

