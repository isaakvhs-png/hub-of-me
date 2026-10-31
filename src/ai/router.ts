import { outputLimit } from "./limits.js";
import { UnpricedModelError, UsageMissingError } from "../errors.js";
import { isPriced } from "../prices.js";
import type { ProviderName, Settings } from "../types.js";
import { anthropicComplete } from "./anthropic.js";
import { geminiComplete } from "./gemini.js";
import { MockProvider } from "./mock.js";
import type { AiRequest, AiResult } from "./types.js";
import { usageIsReal } from "./types.js";

export interface ResolvedModel {
  provider: ProviderName;
  model: string;
}

export function parseModel(spec: string, fallback: ProviderName): ResolvedModel {
  const idx = spec.indexOf(":");
  if (idx > 0) {
    const provider = spec.slice(0, idx);
    const model = spec.slice(idx + 1);
    if ((provider === "anthropic" || provider === "gemini" || provider === "mock") && model) {
      return { provider, model };
    }
  }
  return { provider: fallback, model: spec };
}

export function keysPresent(): { anthropic: boolean; gemini: boolean } {
  return {
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    gemini: Boolean(process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim()),
  };
}

export function readEnvProvider(): { raw: string | null; normalized: ProviderName | null } {
  const raw = process.env.AI_PROVIDER;
  if (raw == null || raw.trim() === "") return { raw: null, normalized: null };
  const trimmed = raw.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === "mock" || normalized === "anthropic" || normalized === "gemini") {
    return { raw: trimmed, normalized };
  }
  return { raw: trimmed, normalized: null };
}

export interface ProviderReport {
  active: ProviderName;
  why: string;
  envAiProvider: string | null;
  envNormalized: ProviderName | null;
  settingsProvider: ProviderName;
  keys: { anthropic: boolean; gemini: boolean };
}

/** Explains which provider calls use. Key values are never included. */
export function providerReport(settingsProvider: ProviderName): ProviderReport {
  const env = readEnvProvider();
  const keys = keysPresent();
  const active = settingsProvider;
  let why: string;
  if (env.raw == null) {
    why = `AI_PROVIDER is unset. Calls use the Settings provider (${active}).`;
  } else if (!env.normalized) {
    why = `AI_PROVIDER is "${env.raw}", which is not mock, anthropic, or gemini. Calls use the Settings provider (${active}).`;
  } else if (env.normalized === active) {
    why = `AI_PROVIDER is ${env.normalized}, and Settings matches it. Calls use ${active}.`;
  } else {
    why = `Settings is ${active}. AI_PROVIDER is ${env.normalized}. Saving Settings applies until the next start, which writes AI_PROVIDER again.`;
  }
  if (active === "anthropic" && !keys.anthropic) {
    why += " ANTHROPIC_API_KEY is missing, so a call fails instead of falling back to mock.";
  }
  if (active === "gemini" && !keys.gemini) {
    why += " GEMINI_API_KEY is missing, so a call fails instead of falling back to mock.";
  }
  if (active === "mock" && (keys.anthropic || keys.gemini)) {
    why += " A real key is present, but calls stay on mock until Settings or AI_PROVIDER selects that provider.";
  }
  return { active, why, envAiProvider: env.raw, envNormalized: env.normalized, settingsProvider, keys };
}

export function resolveRoleModel(settings: Settings, req: Pick<AiRequest, "role" | "debaterIndex">): ResolvedModel {
  if (settings.provider === "mock") {
    if (req.role === "judge") return { provider: "mock", model: "mock-judge" };
    if (req.role === "debater") return { provider: "mock", model: `mock-debater-${req.debaterIndex ?? 0}` };
    if (req.role === "reflection" || req.role === "critic") return { provider: "mock", model: "mock-strong" };
    return { provider: "mock", model: "mock-cheap" };
  }
  if (req.role === "judge") return parseModel(settings.judgeModel, settings.provider);
  if (req.role === "reflection" || req.role === "critic") return parseModel(settings.strongModel, settings.provider);
  if (req.role === "debater") {
    const pool = debaterPool(settings);
    return pool[(req.debaterIndex ?? 0) % pool.length];
  }
  return parseModel(settings.cheapModel, settings.provider);
}

export function debaterPool(settings: Settings): ResolvedModel[] {
  const judge = parseModel(settings.judgeModel, settings.provider);
  const keys = keysPresent();
  const candidates = [settings.cheapModel, settings.alternateModel, settings.strongModel].map((spec) => parseModel(spec, settings.provider));
  const pool: ResolvedModel[] = [];
  for (const candidate of candidates) {
    if (candidate.provider === judge.provider && candidate.model === judge.model) continue;
    if (candidate.provider === "anthropic" && !keys.anthropic && settings.provider !== "anthropic") continue;
    if (candidate.provider === "gemini" && !keys.gemini) continue;
    if (pool.some((item) => item.provider === candidate.provider && item.model === candidate.model)) continue;
    pool.push(candidate);
  }
  if (pool.length === 0) {
    throw new UnpricedModelError("No debater model is distinct from the judge. Set a different cheap or alternate model.");
  }
  return pool;
}

export class Router {
  constructor(
    private settings: Settings,
    private deps: { mock?: MockProvider; fetchImpl?: typeof fetch } = {},
  ) {}

  async complete(req: AiRequest): Promise<AiResult> {
    const resolved = resolveRoleModel(this.settings, req);
    if (!isPriced(resolved.model, this.settings.priceOverrides)) {
      throw new UnpricedModelError(`No list price for ${resolved.model}. Add it before calling. Tokens are not estimated.`);
    }
    const started = Date.now();
    const inputChars = req.system.length + req.messages.reduce((sum, message) => sum + message.content.length, 0);
    const withModel = { ...req, model: resolved.model, maxTokens: req.maxTokens ?? outputLimit(req.role) };
    let text: string;
    let usage: AiResult["usage"];
    let stopReason: string | null = null;
    if (resolved.provider === "mock") {
      if (this.settings.provider !== "mock") {
        throw new Error(`Refusing to use the mock provider while Settings selects ${this.settings.provider}.`);
      }
      const mock = this.deps.mock ?? new MockProvider();
      const result = await mock.complete(withModel);
      text = result.text;
      usage = result.usage;
      stopReason = result.stopReason;
    } else if (resolved.provider === "anthropic") {
      const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
      const result = await anthropicComplete(withModel, apiKey, this.deps.fetchImpl);
      text = result.text;
      usage = result.usage;
      stopReason = result.stopReason;
    } else if (resolved.provider === "gemini") {
      const apiKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
      if (!apiKey) throw new Error("GEMINI_API_KEY is not set.");
      const result = await geminiComplete(withModel, apiKey, this.deps.fetchImpl);
      text = result.text;
      usage = result.usage;
      stopReason = result.stopReason;
    } else {
      throw new Error(`Unknown provider ${resolved.provider}`);
    }
    if (!usageIsReal(usage)) {
      throw new UsageMissingError(`${resolved.provider} returned no usable token counts.`);
    }
    return {
      text,
      usage,
      provider: resolved.provider,
      model: resolved.model,
      durationMs: Date.now() - started,
      inputChars,
      stopReason,
    };
  }
}
