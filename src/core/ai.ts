import { anthropicComplete } from "../ai/anthropic.js";
import { geminiComplete } from "../ai/gemini.js";
import { planAvailable, planComplete, planLimited, planStatus, PlanLimitError } from "../ai/plan.js";
import type { AiRequest } from "../ai/types.js";

/**
 * The models (BUILD_SPEC.md §7). Four tiers, named by the work, not the vendor:
 *  - fast: gather and triage (Haiku),
 *  - main: filing, call A, call B, rewrites (Sonnet),
 *  - deep: when call A chooses it (Opus),
 *  - review: the nightly review, a different model from the worker (Opus reviews Sonnet; or Gemini).
 * Route: the plan (Isaak's Pro token, Agent SDK) first; the API key if there is one; Gemini Flash-Lite as the fallback.
 * Each env var MODEL_FAST / MODEL_MAIN / MODEL_DEEP / MODEL_REVIEW overrides a tier.
 */
export type Tier = "fast" | "main" | "deep" | "review";

export interface CallOpts {
  /** What the call is for (filing, gather, callA, …). The mock answers by task; the record shows it. */
  task: string;
  tier: Tier;
  system: string;
  prompt: string;
  json?: boolean;
  webSearch?: boolean;
  onDelta?: (text: string) => void;
  maxTokens?: number;
}

export interface CallResult {
  text: string;
  model: string;
  provider: string;
  ms: number;
  charsIn: number;
  charsOut: number;
  /** Set when the first route failed and another model answered. */
  fellBack?: string;
}

export interface Models {
  readonly mode: "mock" | "live";
  modelFor(tier: Tier): string;
  call(opts: CallOpts): Promise<CallResult>;
}

const FALLBACK = "gemini-3.5-flash-lite";

export function tierModel(tier: Tier): string {
  const env = process.env[`MODEL_${tier.toUpperCase()}`]?.trim();
  if (env) return env;
  return { fast: "claude-haiku-5-5", main: "claude-sonnet-5-5", deep: "claude-opus-5-5", review: "claude-opus-5-5" }[tier];
}

const geminiKey = () => process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || "";

export class LiveModels implements Models {
  readonly mode = "live" as const;
  constructor(private fetchImpl: typeof fetch = fetch) {}

  modelFor(tier: Tier): string {
    return tierModel(tier);
  }

  async call(opts: CallOpts): Promise<CallResult> {
    const model = this.modelFor(opts.tier);
    const started = Date.now();
    const req: AiRequest & { model: string } = {
      role: "conversation",
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
      model,
      maxTokens: opts.maxTokens ?? (opts.tier === "fast" ? 4000 : 16000),
      structured: opts.json,
      webSearch: opts.webSearch,
      onDelta: opts.onDelta,
    };
    const charsIn = opts.system.length + opts.prompt.length;
    const done = (text: string, provider: string, used: string, fellBack?: string): CallResult => ({ text, model: used, provider, ms: Date.now() - started, charsIn, charsOut: text.length, fellBack });
    if (model.startsWith("gemini")) {
      const key = geminiKey();
      if (!key) throw new Error("GEMINI_API_KEY is not set.");
      const result = await geminiComplete(req, key, this.fetchImpl);
      opts.onDelta?.(result.text);
      return done(result.text, "gemini", model);
    }
    let firstError: unknown = null;
    if (planAvailable() && !planLimited()) {
      try {
        const result = await planComplete(req);
        return done(result.text, "claude-plan", model);
      } catch (error) {
        firstError = error;
      }
    }
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (apiKey) {
      try {
        const result = await anthropicComplete(req, apiKey, this.fetchImpl);
        opts.onDelta?.(result.text);
        return done(result.text, "anthropic", model, firstError ? String((firstError as Error).message ?? firstError).slice(0, 200) : undefined);
      } catch (error) {
        firstError = firstError ?? error;
      }
    }
    const key = geminiKey();
    if (key && !opts.webSearch) {
      // Refusals, limits and outages on the Claude route: Gemini Flash-Lite answers instead, and the record says so.
      const result = await geminiComplete({ ...req, model: FALLBACK }, key, this.fetchImpl);
      opts.onDelta?.(result.text);
      const why = firstError ? String((firstError as Error).message ?? firstError).slice(0, 200) : "no Claude route";
      return done(result.text, "gemini", FALLBACK, why);
    }
    if (firstError) throw firstError;
    throw new Error("No model is set up: CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY or GEMINI_API_KEY.");
  }
}

/** How much of the plan's allowance is used (0..1), when the plan has said; null when unknown. */
export function allowanceUsed(): number | null {
  const status = planStatus();
  if (!status || status.utilization == null) return null;
  return status.utilization > 1 ? status.utilization / 100 : status.utilization;
}

export { PlanLimitError };
