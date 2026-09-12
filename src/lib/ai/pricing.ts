/**
 * Per-model pricing in USD per million tokens, for cost tracking (PRD §43).
 *
 * These are list prices captured at build time; they are used for *estimated*
 * cost only and are labelled as such in the UI. Cached input reads are billed
 * at a fraction of the input rate.
 */
interface Price {
  input: number;
  output: number;
  cachedInput: number;
}

const PRICES: Record<string, Price> = {
  "claude-opus-5": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cachedInput: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cachedInput: 0.1 },
  "offline-deterministic": { input: 0, output: 0, cachedInput: 0 },
};

const DEFAULT: Price = { input: 5, output: 25, cachedInput: 0.5 };

export function priceFor(model: string): Price {
  return PRICES[model] ?? DEFAULT;
}

export function estimateCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number },
): number {
  const price = priceFor(model);
  const cached = usage.cachedTokens ?? 0;
  const fresh = Math.max(0, usage.inputTokens - cached);
  const cost =
    (fresh / 1_000_000) * price.input +
    (cached / 1_000_000) * price.cachedInput +
    (usage.outputTokens / 1_000_000) * price.output;
  // Round to a tenth of a cent's thousandth — enough precision for per-request rows.
  return Math.round(cost * 1e8) / 1e8;
}

/**
 * Rough token estimate for budget pre-checks and for the offline provider,
 * where no real tokeniser runs. ~4 characters per token for English prose.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export const KNOWN_MODELS = Object.keys(PRICES);
