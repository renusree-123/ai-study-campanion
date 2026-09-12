import { env } from "./env";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  traceId?: string;
  userId?: string;
  projectId?: string;
  [key: string]: unknown;
}

/**
 * Structured JSON logger. One line per event so the output is greppable in
 * `vercel logs` / `docker logs` and parseable by any log shipper.
 */
class Logger {
  constructor(private readonly base: LogContext = {}) {}

  child(context: LogContext): Logger {
    return new Logger({ ...this.base, ...context });
  }

  private write(level: Level, message: string, context?: LogContext) {
    if (ORDER[level] < ORDER[env().LOG_LEVEL]) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...this.base,
      ...context,
    };
    const serialised = JSON.stringify(line, (_k, v) =>
      v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v,
    );
    if (level === "error") console.error(serialised);
    else if (level === "warn") console.warn(serialised);
    else console.log(serialised);
  }

  debug = (m: string, c?: LogContext) => this.write("debug", m, c);
  info = (m: string, c?: LogContext) => this.write("info", m, c);
  warn = (m: string, c?: LogContext) => this.write("warn", m, c);
  error = (m: string, c?: LogContext) => this.write("error", m, c);

  /** Times an operation and logs its outcome. Re-throws on failure. */
  async time<T>(message: string, fn: () => Promise<T>, context?: LogContext): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      this.debug(message, { ...context, durationMs: Date.now() - started, outcome: "ok" });
      return result;
    } catch (error) {
      this.error(message, {
        ...context,
        durationMs: Date.now() - started,
        outcome: "error",
        error,
      });
      throw error;
    }
  }
}

export const logger = new Logger();

export function newTraceId(): string {
  return `tr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
