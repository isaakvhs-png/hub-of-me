import type { ZodType } from "zod";
import type { Db } from "../db.js";
import { BudgetError, ValidationError } from "../errors.js";
import { extractJson } from "../json.js";
import { costUsdCents, toEurCents } from "../prices.js";
import { getBudget, getSettings, insertUsage, spendSince } from "../repo.js";
import { startOfMonth } from "../time.js";
import type { AiRequest, AiResult } from "./types.js";
import type { Router } from "./router.js";

export interface TrackMeta {
  conversationId?: string | null;
  jobId?: string | null;
  jobKind?: string | null;
}

export async function assertCanSpend(db: Db, userId: string): Promise<void> {
  const budget = await getBudget(db, userId);
  const since = startOfMonth("Europe/Amsterdam").toISOString();
  const spend = await spendSince(db, userId, since);
  if (spend.unpriced > 0) {
    throw new BudgetError("A previous call has no known price. Add that model's list price before spending more. The token counts were kept; a cost was not invented.");
  }
  if (spend.spentEurCents >= budget.monthlyCapEurCents) {
    const spent = (spend.spentEurCents / 100).toFixed(2);
    const cap = (budget.monthlyCapEurCents / 100).toFixed(2);
    throw new BudgetError(`Monthly cap reached: ${spent} EUR of ${cap} EUR.`);
  }
}

export async function trackedComplete(db: Db, userId: string, ai: Router, req: AiRequest, meta: TrackMeta = {}): Promise<AiResult> {
  await assertCanSpend(db, userId);
  const result = await ai.complete(req);
  const settings = await getSettings(db, userId);
  const usd = costUsdCents(result.model, result.usage, settings.priceOverrides);
  const priceKnown = usd != null;
  await insertUsage(db, {
    userId,
    role: req.role,
    provider: result.provider,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheWriteTokens: result.usage.cacheWriteTokens ?? 0,
    cacheReadTokens: result.usage.cacheReadTokens ?? 0,
    costUsdCents: usd,
    costEurCents: priceKnown ? toEurCents(usd, settings.usdToEur) : null,
    priceKnown,
    durationMs: result.durationMs,
    inputChars: result.inputChars,
    outputText: result.text,
    conversationId: meta.conversationId ?? null,
    jobId: meta.jobId ?? null,
    jobKind: meta.jobKind ?? null,
  });
  return result;
}

export async function completeText(db: Db, userId: string, ai: Router, req: AiRequest, meta?: TrackMeta): Promise<string> {
  const result = await trackedComplete(db, userId, ai, req, meta);
  return result.text.trim();
}

export async function completeJson<T>(
  db: Db,
  userId: string,
  ai: Router,
  req: AiRequest,
  schema: ZodType<T>,
  meta: TrackMeta & { reject?: (text: string) => string | null },
): Promise<T> {
  const messages = [...req.messages];
  let last = "invalid";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await trackedComplete(db, userId, ai, { ...req, messages }, meta);
    try {
      const parsed = schema.parse(extractJson(result.text));
      const reason = meta.reject?.(result.text) ?? null;
      if (reason) {
        last = reason;
        messages.push({ role: "assistant", content: result.text });
        messages.push({ role: "user", content: `Rejected by code: ${reason}. Return one JSON object only.` });
        continue;
      }
      return parsed;
    } catch (error) {
      last = error instanceof Error ? error.message : "invalid";
      messages.push({ role: "assistant", content: result.text });
      messages.push({ role: "user", content: `Rejected by code: the output did not match the required form (${last}). Return one JSON object only.` });
    }
  }
  throw new ValidationError(last);
}
