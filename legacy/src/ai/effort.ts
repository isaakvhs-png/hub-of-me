import type { Db } from "../db.js";
import { claudeAvailable } from "./plan.js";
import type { ProviderName, Settings } from "../types.js";

export interface RoutedModel {
  provider: ProviderName;
  model: string;
  why: string;
}

/** Free-tier ceilings named for routing. Pro is not used. Flash is not the light default. */
export const FREE_QUOTA = [
  { model: "gemini-3.5-flash-lite", perDay: 500, perMinute: 15 },
  { model: "gemini-2.5-flash", perDay: 20, perMinute: 10 },
  { model: "gemini-2.5-pro", perDay: 0, perMinute: 0 },
] as const;

export const LIGHT_MODEL = "gemini-3.5-flash-lite";
export const CONVERSATION_MODEL = "claude-haiku-5-5";
export const DEEP_MODEL = "claude-sonnet-5-5";

export type Effort = "light" | "conversation" | "deep";

export function chooseModel(input: {
  effort: Effort;
  gemini: boolean;
  anthropic: boolean;
  usedToday: Record<string, number>;
  usedMinute: Record<string, number>;
}): RoutedModel {
  const lite = FREE_QUOTA[0];
  const liteToday = input.usedToday[lite.model] ?? 0;
  const liteMinute = input.usedMinute[lite.model] ?? 0;
  const liteOpen = input.gemini && liteToday < lite.perDay && liteMinute < lite.perMinute;
  if (input.effort === "light" && liteOpen) {
    return { provider: "gemini", model: lite.model, why: "Light work, and Flash-Lite is inside its free quota." };
  }
  if (!input.anthropic) {
    throw new Error("Claude is not set up: neither CLAUDE_CODE_OAUTH_TOKEN (the plan) nor ANTHROPIC_API_KEY is set.");
  }
  if (input.effort === "deep") {
    return { provider: "anthropic", model: DEEP_MODEL, why: "Deep thinking uses Sonnet." };
  }
  if (input.effort === "light") {
    const why = input.gemini ? "Flash-Lite is at its quota, so this light call uses Haiku." : "No Gemini key, so this light call uses Haiku.";
    return { provider: "anthropic", model: CONVERSATION_MODEL, why };
  }
  return { provider: "anthropic", model: CONVERSATION_MODEL, why: "Conversation uses Haiku." };
}

export function isQuotaError(message: string): boolean {
  return /429|quota|resource_exhausted|rate limit/i.test(message);
}

export async function usageWindows(db: Db, userId: string, now = new Date()): Promise<{ usedToday: Record<string, number>; usedMinute: Record<string, number> }> {
  const day = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const rows = await db.query(
    `SELECT model, created_at FROM usage_records WHERE user_id = $1 AND provider = 'gemini' AND created_at >= $2`,
    [userId, day],
  );
  const usedToday: Record<string, number> = {};
  const usedMinute: Record<string, number> = {};
  for (const row of rows.rows) {
    const model = String(row.model);
    usedToday[model] = (usedToday[model] ?? 0) + 1;
    const at = new Date(String(row.created_at)).getTime();
    if (!Number.isNaN(at) && at >= now.getTime() - 60 * 1000) usedMinute[model] = (usedMinute[model] ?? 0) + 1;
  }
  return { usedToday, usedMinute };
}

export async function routeEffort(db: Db, userId: string, settings: Settings, effort: Effort): Promise<RoutedModel> {
  if (settings.provider === "mock") {
    const model = effort === "deep" ? "mock-strong" : "mock-cheap";
    return { provider: "mock", model, why: "Settings are on mock, so this call stays on mock." };
  }
  const windows = await usageWindows(db, userId);
  return chooseModel({
    effort,
    gemini: Boolean(process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim()),
    anthropic: claudeAvailable(),
    ...windows,
  });
}
