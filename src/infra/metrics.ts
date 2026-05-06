export interface CounterSample {
  name: string;
  value: number;
  tags: Record<string, string>;
}

export interface GaugeSample {
  name: string;
  value: number;
  tags: Record<string, string>;
}

export interface TimerSample {
  name: string;
  count: number;
  totalMs: number;
  meanMs: number;
  maxMs: number;
  tags: Record<string, string>;
}

export interface MetricsSnapshot {
  counters: CounterSample[];
  gauges: GaugeSample[];
  timers: TimerSample[];
}

interface TimerAggregate {
  count: number;
  totalMs: number;
  maxMs: number;
  tags: Record<string, string>;
}

export class MetricsRegistry {
  private counters = new Map<string, CounterSample>();
  private gauges = new Map<string, GaugeSample>();
  private timers = new Map<string, TimerAggregate>();

  increment(name: string, value: number = 1, tags: Record<string, string> = {}) {
    const key = metricKey(name, tags);
    const current = this.counters.get(key);
    if (current) {
      current.value += value;
      return;
    }
    this.counters.set(key, { name, value, tags: { ...tags } });
  }

  setGauge(name: string, value: number, tags: Record<string, string> = {}) {
    this.gauges.set(metricKey(name, tags), {
      name,
      value,
      tags: { ...tags },
    });
  }

  recordTimer(name: string, durationMs: number, tags: Record<string, string> = {}) {
    const key = metricKey(name, tags);
    const current = this.timers.get(key);
    if (current) {
      current.count += 1;
      current.totalMs += durationMs;
      current.maxMs = Math.max(current.maxMs, durationMs);
      return;
    }
    this.timers.set(key, {
      count: 1,
      totalMs: durationMs,
      maxMs: durationMs,
      tags: { ...tags },
    });
  }

  async time<T>(name: string, fn: () => Promise<T>, tags: Record<string, string> = {}) {
    const startedAt = Date.now();
    try {
      return await fn();
    } finally {
      this.recordTimer(name, Date.now() - startedAt, tags);
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: [...this.counters.values()]
        .map((sample) => ({ ...sample, tags: { ...sample.tags } }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      gauges: [...this.gauges.values()]
        .map((sample) => ({ ...sample, tags: { ...sample.tags } }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      timers: [...this.timers.entries()]
        .map(([key, sample]) => ({
          name: parseMetricName(key),
          count: sample.count,
          totalMs: round(sample.totalMs),
          meanMs: round(sample.totalMs / Math.max(sample.count, 1)),
          maxMs: round(sample.maxMs),
          tags: { ...sample.tags },
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
}

function metricKey(name: string, tags: Record<string, string>) {
  const suffix = Object.entries(tags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return `${name}::${suffix}`;
}

function parseMetricName(key: string) {
  return key.split("::")[0] || key;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

