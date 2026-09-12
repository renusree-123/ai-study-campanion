import { db } from "../db";
import { env, hasLiveProvider } from "../env";
import { AppError, errorMessage, isRetryable } from "../errors";
import { logger } from "../logger";
import { AnthropicProvider } from "./anthropic";
import { OfflineProvider } from "./offline";
import { estimateCostUsd } from "./pricing";
import type {
  AiCallMeta,
  AiProvider,
  AiResult,
  DocumentUnderstandingRequest,
  GenerateStructuredRequest,
  GenerateTextRequest,
  StreamResult,
} from "./types";

/**
 * AI router — the single entry point for every model call in the product.
 *
 * Responsibilities:
 *   1. Provider selection (live Anthropic, or the offline provider)
 *   2. Timeout, bounded retry with jittered backoff
 *   3. Fallback to a cheaper model, then to the offline provider, so a
 *      provider outage degrades the experience instead of breaking it
 *   4. Recording every attempt in AiRequestLog: model, latency, tokens,
 *      estimated cost, feature, status (PRD §43, §44)
 *   5. Enforcing an optional per-user daily spend cap
 *
 * Logging is deliberately fire-and-forget: an observability write must never
 * fail a user-facing request.
 */

let primary: AiProvider | null = null;
let fallback: AiProvider | null = null;
const offline = new OfflineProvider();

export function getPrimaryProvider(): AiProvider {
  if (primary) return primary;
  const config = env();
  if (config.AI_PROVIDER === "offline" || !hasLiveProvider()) {
    primary = offline;
  } else {
    primary = new AnthropicProvider(config.ANTHROPIC_API_KEY!, config.AI_MODEL);
  }
  return primary;
}

function getFallbackProvider(): AiProvider | null {
  const config = env();
  if (!hasLiveProvider() || config.AI_PROVIDER === "offline") return null;
  if (config.AI_FALLBACK_MODEL === config.AI_MODEL) return null;
  fallback ??= new AnthropicProvider(config.ANTHROPIC_API_KEY!, config.AI_FALLBACK_MODEL);
  return fallback;
}

export function getOfflineProvider(): AiProvider {
  return offline;
}

/** Reset memoised providers — used by tests that change env between cases. */
export function resetProviders() {
  primary = null;
  fallback = null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number): number {
  const base = Math.min(8000, 400 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250); // jitter avoids retry stampedes
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new AppError("AI_TIMEOUT", `${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function recordUsage(params: {
  meta: AiCallMeta;
  provider: string;
  model: string;
  status: string;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number; cachedTokens: number };
  error?: string;
  retries: number;
  fellBackTo?: string;
}) {
  const usage = params.usage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  try {
    await db.aiRequestLog.create({
      data: {
        traceId: params.meta.traceId,
        userId: params.meta.userId ?? null,
        projectId: params.meta.projectId ?? null,
        feature: params.meta.feature,
        promptId: params.meta.promptId,
        promptVersion: params.meta.promptVersion,
        provider: params.provider,
        model: params.model,
        status: params.status,
        fellBackTo: params.fellBackTo ?? null,
        latencyMs: params.latencyMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        costUsd: estimateCostUsd(params.model, usage),
        retries: params.retries,
        cacheHit: usage.cachedTokens > 0,
        error: params.error ? params.error.slice(0, 800) : null,
      },
    });
  } catch (error) {
    logger.warn("ai_usage_log_failed", { traceId: params.meta.traceId, error });
  }
}

/** Per-user daily spend cap. Returns the amount already spent today. */
async function assertWithinBudget(meta: AiCallMeta): Promise<void> {
  const cap = env().AI_DAILY_BUDGET_USD;
  if (cap <= 0 || !meta.userId) return;
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const spend = await db.aiRequestLog.aggregate({
    where: { userId: meta.userId, createdAt: { gte: since } },
    _sum: { costUsd: true },
  });
  const spent = spend._sum.costUsd ?? 0;
  if (spent >= cap) {
    throw new AppError(
      "BUDGET_EXCEEDED",
      `Daily AI budget of $${cap} reached (spent $${spent.toFixed(4)}).`,
      {
        userMessage:
          "You have reached today's AI usage limit for this account. It resets at midnight UTC.",
      },
    );
  }
}

interface AttemptOutcome<T> {
  result: AiResult<T>;
  provider: AiProvider;
  retries: number;
}

/**
 * Runs `call` against the primary provider with retries, then the fallback
 * model, then the offline provider if `allowOfflineFallback` is set.
 */
async function execute<T>(
  meta: AiCallMeta,
  call: (provider: AiProvider) => Promise<AiResult<T>>,
  options: { allowOfflineFallback: boolean; label: string },
): Promise<AttemptOutcome<T>> {
  await assertWithinBudget(meta);

  const chain: AiProvider[] = [getPrimaryProvider()];
  const secondary = getFallbackProvider();
  if (secondary) chain.push(secondary);
  if (options.allowOfflineFallback && !chain.includes(offline)) chain.push(offline);

  const maxRetries = env().AI_MAX_RETRIES;
  let lastError: unknown;
  let totalRetries = 0;

  for (let providerIndex = 0; providerIndex < chain.length; providerIndex += 1) {
    const provider = chain[providerIndex];
    // Only the primary provider gets retries; a fallback is already a retry.
    const attempts = providerIndex === 0 ? maxRetries + 1 : 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const started = Date.now();
      try {
        const result = await withTimeout(
          call(provider),
          env().AI_TIMEOUT_MS,
          `${options.label} (${provider.id})`,
        );
        await recordUsage({
          meta,
          provider: provider.id,
          model: result.model,
          status: providerIndex === 0 ? "SUCCESS" : "FALLBACK",
          latencyMs: result.latencyMs,
          usage: result.usage,
          retries: totalRetries,
          fellBackTo: providerIndex === 0 ? undefined : provider.model,
        });
        return { result, provider, retries: totalRetries };
      } catch (error) {
        lastError = error;
        const message = errorMessage(error);
        const status =
          error instanceof AppError && error.code === "AI_TIMEOUT"
            ? "TIMEOUT"
            : error instanceof AppError && error.code === "AI_INVALID_OUTPUT"
              ? "INVALID_OUTPUT"
              : "ERROR";

        await recordUsage({
          meta,
          provider: provider.id,
          model: provider.model,
          status,
          latencyMs: Date.now() - started,
          error: message,
          retries: totalRetries,
        });

        logger.warn("ai_attempt_failed", {
          traceId: meta.traceId,
          feature: meta.feature,
          provider: provider.id,
          attempt,
          error: message,
        });

        // A budget rejection is the user's answer, not a transient failure.
        if (error instanceof AppError && error.code === "BUDGET_EXCEEDED") throw error;

        const willRetrySameProvider = attempt < attempts - 1 && isRetryable(error);
        if (willRetrySameProvider) {
          totalRetries += 1;
          await sleep(backoffMs(attempt));
          continue;
        }
        // Invalid structured output is worth one shot at another model, but
        // not worth hammering the same one.
        break;
      }
    }
  }

  throw lastError instanceof AppError
    ? lastError
    : new AppError("AI_PROVIDER_ERROR", `${options.label} failed: ${errorMessage(lastError)}`, {
        userMessage:
          "The AI service is unavailable right now. Your learning data is unchanged — please try again shortly.",
        cause: lastError,
      });
}

export const ai = {
  async generateText(
    request: GenerateTextRequest,
    meta: AiCallMeta,
    options: { allowOfflineFallback?: boolean } = {},
  ): Promise<AiResult<string>> {
    const outcome = await execute(meta, (p) => p.generateText(request, meta), {
      allowOfflineFallback: options.allowOfflineFallback ?? true,
      label: `generateText:${meta.feature}`,
    });
    return outcome.result;
  },

  async generateStructured<T>(
    request: GenerateStructuredRequest<T>,
    meta: AiCallMeta,
    options: { allowOfflineFallback?: boolean } = {},
  ): Promise<AiResult<T>> {
    const outcome = await execute(meta, (p) => p.generateStructured(request, meta), {
      allowOfflineFallback: options.allowOfflineFallback ?? true,
      label: `generateStructured:${meta.feature}`,
    });
    return outcome.result;
  },

  /**
   * Streaming has no automatic fallback: by the time a stream fails, bytes may
   * already have reached the browser. The caller decides how to recover.
   */
  async streamText(request: GenerateTextRequest, meta: AiCallMeta): Promise<StreamResult> {
    await assertWithinBudget(meta);
    const provider = getPrimaryProvider();
    const started = Date.now();
    try {
      const stream = await provider.streamText(request, meta);
      return {
        stream: stream.stream,
        final: async () => {
          try {
            const result = await stream.final();
            await recordUsage({
              meta,
              provider: provider.id,
              model: result.model,
              status: "SUCCESS",
              latencyMs: result.latencyMs,
              usage: result.usage,
              retries: 0,
            });
            return result;
          } catch (error) {
            await recordUsage({
              meta,
              provider: provider.id,
              model: provider.model,
              status: "ERROR",
              latencyMs: Date.now() - started,
              error: errorMessage(error),
              retries: 0,
            });
            throw error;
          }
        },
      };
    } catch (error) {
      await recordUsage({
        meta,
        provider: provider.id,
        model: provider.model,
        status: "ERROR",
        latencyMs: Date.now() - started,
        error: errorMessage(error),
        retries: 0,
      });
      throw error;
    }
  },

  async understandDocument(
    request: DocumentUnderstandingRequest,
    meta: AiCallMeta,
  ): Promise<AiResult<string>> {
    const outcome = await execute(meta, (p) => p.understandDocument(request, meta), {
      allowOfflineFallback: true,
      label: "understandDocument",
    });
    return outcome.result;
  },

  async health() {
    return getPrimaryProvider().health();
  },

  describe() {
    const provider = getPrimaryProvider();
    return {
      provider: provider.id,
      model: provider.model,
      isLive: provider.isLive,
      fallbackModel: getFallbackProvider()?.model ?? null,
    };
  },
};
