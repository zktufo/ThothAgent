export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  bindings?: Record<string, unknown>;
}

export interface LogRecord {
  ts: string;
  level: LogLevel;
  service: string;
  message: string;
  bindings?: Record<string, unknown>;
  data?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  readonly service: string;
  readonly level: LogLevel;
  readonly bindings: Record<string, unknown>;

  constructor(options: LoggerOptions) {
    this.service = options.service;
    this.level = options.level ?? "info";
    this.bindings = { ...(options.bindings || {}) };
  }

  child(bindings: Record<string, unknown>) {
    return new Logger({
      service: this.service,
      level: this.level,
      bindings: {
        ...this.bindings,
        ...bindings,
      },
    });
  }

  debug(message: string, data?: Record<string, unknown>) {
    this.write("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>) {
    this.write("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>) {
    this.write("warn", message, data);
  }

  error(message: string, error?: unknown, data?: Record<string, unknown>) {
    this.write("error", message, data, error);
  }

  private write(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
    error?: unknown,
  ) {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;

    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      service: this.service,
      message,
      bindings: Object.keys(this.bindings).length ? this.bindings : undefined,
      data: data && Object.keys(data).length ? data : undefined,
      error: error ? normalizeError(error) : undefined,
    };

    const line = JSON.stringify(record);
    if (level === "error") {
      console.error(line);
      return;
    }
    if (level === "warn") {
      console.warn(line);
      return;
    }
    console.log(line);
  }
}

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

