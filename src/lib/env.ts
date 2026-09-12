import { z } from "zod";

/**
 * Environment configuration.
 *
 * Everything the app needs to run is optional except DATABASE_URL and
 * AUTH_SECRET (which has a dev-only fallback). Notably ANTHROPIC_API_KEY is
 * optional: with no key the AI layer falls back to the deterministic offline
 * provider so the product, the test suite and the eval harness all still run.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().default("file:./dev.db"),

  AUTH_SECRET: z.string().min(16).default("dev-only-insecure-secret-change-me"),
  AUTH_COOKIE_NAME: z.string().default("asc_session"),
  AUTH_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 7),

  ANTHROPIC_API_KEY: z.string().optional(),
  AI_PROVIDER: z.enum(["auto", "anthropic", "offline"]).default("auto"),
  AI_MODEL: z.string().default("claude-opus-5"),
  AI_FALLBACK_MODEL: z.string().default("claude-sonnet-5"),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  /** Hard ceiling on AI spend per user per day, in USD. 0 disables. */
  AI_DAILY_BUDGET_USD: z.coerce.number().min(0).default(0),

  STORAGE_DIR: z.string().default("./storage"),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(20),

  /** Run the job worker inside the web process. Set false when running a separate worker. */
  WORKER_IN_PROCESS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),

  /** Allow self-service registration. Turn off for a locked-down demo. */
  ALLOW_REGISTRATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const INSECURE_DEFAULT_SECRET = "dev-only-insecure-secret-change-me";

/**
 * Fails a production deployment that never set AUTH_SECRET.
 *
 * Deliberately not run at module load: `next build` executes route modules
 * with NODE_ENV=production to collect page data, and the build machine has no
 * reason to hold runtime secrets. This is called at boot (instrumentation) and
 * again at the point the secret is actually used, so a misconfigured deploy
 * fails immediately and loudly rather than silently signing sessions with a
 * public key.
 */
export function assertProductionSecrets(): void {
  const value = env();
  if (value.NODE_ENV !== "production") return;
  if (value.AUTH_SECRET === INSECURE_DEFAULT_SECRET) {
    throw new Error(
      "AUTH_SECRET is still the development default. Set a strong value " +
        "(openssl rand -base64 48) before running in production.",
    );
  }
}

let cached: Env | null = null;
export function env(): Env {
  cached ??= load();
  return cached;
}

/** True when a real AI provider is configured and selected. */
export function hasLiveProvider(): boolean {
  const e = env();
  if (e.AI_PROVIDER === "offline") return false;
  return Boolean(e.ANTHROPIC_API_KEY);
}
