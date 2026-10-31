/**
 * List prices in USD per million tokens.
 * Sources, checked 31 Oct 2026:
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 *   Haiku 5.5 is $0.10 / $0.50 under 100k prompt tokens, and $0.50 / $2.50 above.
 *   Sonnet 5.5 is $2 / $10. Cache write is the 5-minute cache rate.
 * - Gemini: https://ai.google.dev/gemini-api/docs/pricing
 *   2.5 Flash text $0.30 / $2.50. 2.5 Pro $1.25 / $10 up to 200k, then $2.50 / $15.
 * Token counts are never taken from this file. It only prices counts a provider already returned.
 * USD→EUR default is the 31 Oct 2026 market rate (about 0.8959). Override with USD_TO_EUR.
 */

export type Price = {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  cacheWritePerMTokUsd?: number;
  cacheReadPerMTokUsd?: number;
  /** When set, rates switch once reported input tokens pass this count. */
  longContextFrom?: number;
  longInputPerMTokUsd?: number;
  longOutputPerMTokUsd?: number;
};

export const LIST_PRICES: Record<string, Price> = {
  "claude-haiku-5-5": {
    inputPerMTokUsd: 0.1,
    outputPerMTokUsd: 0.5,
    cacheWritePerMTokUsd: 0.125,
    cacheReadPerMTokUsd: 0.01,
    longContextFrom: 100_000,
    longInputPerMTokUsd: 0.5,
    longOutputPerMTokUsd: 2.5,
  },
  "claude-sonnet-5-5": {
    inputPerMTokUsd: 2,
    outputPerMTokUsd: 10,
    cacheWritePerMTokUsd: 2.5,
    cacheReadPerMTokUsd: 0.1,
  },
  "gemini-2.5-flash": { inputPerMTokUsd: 0.3, outputPerMTokUsd: 2.5 },
  "gemini-2.5-pro": {
    inputPerMTokUsd: 1.25,
    outputPerMTokUsd: 10,
    longContextFrom: 200_000,
    longInputPerMTokUsd: 2.5,
    longOutputPerMTokUsd: 15,
  },
  "mock-cheap": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
  "mock-strong": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
  "mock-judge": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
  "mock-debater-0": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
  "mock-debater-1": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
  "mock-debater-2": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
  "mock-debater-3": { inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
  "priced-test": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
};

export const DEFAULT_USD_TO_EUR = 0.8959;

export type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
};

export function priceFor(model: string, overrides?: Record<string, Price>): Price | null {
  return overrides?.[model] ?? LIST_PRICES[model] ?? null;
}

export function isPriced(model: string, overrides?: Record<string, Price>): boolean {
  return priceFor(model, overrides) != null;
}

/** US cents, including fractions of a cent. Uses only the counts passed in and the list price. */
export function costUsdCents(model: string, usage: TokenCounts, overrides?: Record<string, Price>): number | null {
  const price = priceFor(model, overrides);
  if (!price) return null;
  const long = price.longContextFrom != null && usage.inputTokens > price.longContextFrom;
  const inputRate = long && price.longInputPerMTokUsd != null ? price.longInputPerMTokUsd : price.inputPerMTokUsd;
  const outputRate = long && price.longOutputPerMTokUsd != null ? price.longOutputPerMTokUsd : price.outputPerMTokUsd;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  if ((cacheWrite > 0 && price.cacheWritePerMTokUsd == null) || (cacheRead > 0 && price.cacheReadPerMTokUsd == null)) {
    return null;
  }
  const usd =
    (usage.inputTokens / 1_000_000) * inputRate +
    (usage.outputTokens / 1_000_000) * outputRate +
    (cacheWrite / 1_000_000) * (price.cacheWritePerMTokUsd ?? 0) +
    (cacheRead / 1_000_000) * (price.cacheReadPerMTokUsd ?? 0);
  return usd * 100;
}

export function toEurCents(usdCents: number, usdToEur: number): number {
  return usdCents * usdToEur;
}
