import { anthropicComplete } from "./ai/anthropic.js";
import { geminiComplete } from "./ai/gemini.js";
import { planAvailable, planComplete, planLimited, planStatus } from "./ai/plan.js";
import type { AiRequest } from "./ai/types.js";
import { db } from "./state.js";
import { id } from "./ids.js";
import { popup } from "./popups.js";

/**
 * The models. No model stands in for another (Isaak, 15 Nov): when Sonnet can't answer, the chat shuts down; when
 * Opus can't, the projects shut down; when Gemini can't, placing and summaries shut down. Each shutdown is a big popup.
 */
export type Role = "chat" | "work" | "web" | "check";

export const ROLE_MODEL: Record<Role, string> = {
  chat: process.env.MODEL_CHAT?.trim() || "claude-sonnet-5-5",
  work: process.env.MODEL_WORK?.trim() || "claude-opus-5-5",
  web: process.env.MODEL_WEB?.trim() || "claude-haiku-5-5",
  check: process.env.MODEL_CHECK?.trim() || "claude-haiku-5-5",
};

export const ROLE_NAME: Record<Role, string> = {
  chat: "The chat",
  work: "Projects (the workspace and its own work)",
  web: "Placing and summaries",
  check: "The runaway check",
};

export interface CallOpts {
  task: string;
  system: string;
  prompt: string;
  json?: boolean;
  webSearch?: boolean;
  maxTokens?: number;
  images?: { mediaType: string; base64: string }[];
}

export interface CallResult { text: string; model: string; ms: number }

type MockFn = (opts: CallOpts & { model: string }) => string | Promise<string>;
let mock: MockFn | null = null;
/** Tests (and AI_PROVIDER=mock) answer every call with this. */
export function setMock(fn: MockFn | null) { mock = fn; }
export const isMock = () => mock !== null;

export class ModelDownError extends Error {
  constructor(public role: Role | null, public model: string, message: string) { super(message); this.name = "ModelDownError"; }
}

const geminiKey = () => process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || "";

const down = new Map<Role, { since: string; why: string }>();
export const roleDown = (role: Role) => down.get(role) ?? null;
export const downRoles = () => [...down.entries()].map(([role, d]) => ({ role, name: ROLE_NAME[role], model: ROLE_MODEL[role], ...d }));

async function raw(model: string, opts: CallOpts, priority = 0): Promise<{ text: string; provider: string }> {
  if (mock) return { text: await mock({ ...opts, model }), provider: "mock" };
  const req: AiRequest & { model: string } = {
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
    model,
    maxTokens: Math.max(opts.maxTokens ?? 8000, model.startsWith("gemini") ? 8000 : 0),
    structured: opts.json,
    // Gemini counts its thinking inside the output budget; keep it low so the answer itself fits.
    ...(model.startsWith("gemini") ? { thinking: "low" as const } : {}),
    webSearch: opts.webSearch,
    images: opts.images,
    priority,
  };
  if (model.startsWith("gemini")) {
    const key = geminiKey();
    if (!key) throw new Error("GEMINI_API_KEY is not set.");
    const r = await geminiComplete(req, key);
    return { text: r.text, provider: "gemini" };
  }
  // Claude: the plan first (Isaak's own plan), then the API key. Same model either way.
  let firstError: unknown = null;
  if (planAvailable() && !planLimited(model)) {
    try { return { text: (await planComplete(req)).text, provider: "claude-plan" }; } catch (error) { firstError = error; }
  }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    try { return { text: (await anthropicComplete(req, apiKey)).text, provider: "anthropic" }; } catch (error) { firstError = firstError ?? error; }
  }
  if (firstError) throw firstError;
  throw new Error("No route to Claude: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is not set.");
}

async function record(task: string, model: string, provider: string, ok: boolean, ms: number, charsIn: number, charsOut: number, error?: string) {
  try {
    await db().query(`INSERT INTO calls (id, task, model, provider, ok, ms, chars_in, chars_out, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id(), task, model, provider, ok, ms, charsIn, charsOut, error?.slice(0, 500) ?? null]);
  } catch { /* the record is not worth failing a call over */ }
}

/** One call to a named model (the board's model pieces). Retries once. */
export async function callModel(model: string, opts: CallOpts, role: Role | null = null): Promise<CallResult> {
  const started = Date.now();
  const charsIn = opts.system.length + opts.prompt.length;
  let lastError: unknown = null;
  const rateLimited = (e: unknown) => /quota|rate.?limit|429|resource.?exhausted/i.test(e instanceof Error ? e.message : String(e));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { text, provider } = await raw(model, opts, role === "chat" ? 10 : role === "web" || role === "check" ? 5 : 0);
      const ms = Date.now() - started;
      await record(opts.task, model, provider, true, ms, charsIn, text.length);
      if (role && down.has(role)) {
        down.delete(role);
        await popup("back", `${ROLE_NAME[role]} is working again`, `${model} answers again.`);
      }
      return { text, model, ms };
    } catch (error) {
      lastError = error;
      if (mock) break;
      // A per-minute limit passes by itself: wait a minute before trying again instead of shutting down at once.
      await new Promise((r) => setTimeout(r, rateLimited(error) ? 65_000 : 1500));
    }
  }
  const why = lastError instanceof Error ? lastError.message : String(lastError);
  console.error(`model call failed: ${model} (${opts.task}): ${why}`);
  await record(opts.task, model, mock ? "mock" : "live", false, Date.now() - started, charsIn, 0, why);
  if (role && !down.has(role)) {
    down.set(role, { since: new Date().toISOString(), why: why.slice(0, 300) });
    await popup("shutdown", `${ROLE_NAME[role]} has shut down`, `${model} is not available, so this stops until it answers again.\n\nWhy: ${why.slice(0, 300)}`);
  }
  throw new ModelDownError(role, model, `${model} is not available: ${why.slice(0, 300)}`);
}

/** One call for a role: the chat (Sonnet), work (Opus), web (Gemini Flash), check (a cheap model). */
export function call(role: Role, opts: CallOpts): Promise<CallResult> {
  return callModel(ROLE_MODEL[role], opts, role);
}

/** The first JSON object in a model's answer. */
export function parseJson<T = Record<string, unknown>>(text: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(trimmed) as T; } catch { /* look for the object inside */ }
  const start = trimmed.indexOf("{");
  if (start < 0) throw new Error("The model returned no JSON.");
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") { depth -= 1; if (depth === 0) return JSON.parse(trimmed.slice(start, i + 1)) as T; }
  }
  throw new Error("The model returned broken JSON.");
}

/** A JSON call, asked again once if the answer does not parse. */
export async function callJson<T = Record<string, unknown>>(role: Role, opts: CallOpts): Promise<T> {
  const first = await call(role, { ...opts, json: true });
  try { return parseJson<T>(first.text); } catch {
    const again = await call(role, { ...opts, json: true, prompt: `${opts.prompt}\n\nYour last answer was not one valid JSON object. Answer again with exactly one JSON object.` });
    return parseJson<T>(again.text);
  }
}

/** The models the board's Lego folder offers: Claude's three, and whatever Gemini models the key reaches. */
let geminiList: string[] | null = null;
export async function modelFolder(): Promise<{ claude: string[]; gemini: string[] }> {
  const claude = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
  if (geminiList) return { claude, gemini: geminiList };
  const fallbackList = ["gemini-3.5-flash", "gemini-3.5-flash-lite"];
  const key = geminiKey();
  if (!key || mock) { geminiList = fallbackList; return { claude, gemini: geminiList }; }
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`);
    const j = (await r.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    const names = (j.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => /^gemini-/.test(n) && !/embedding|tts|image|audio|live/i.test(n));
    geminiList = names.length ? names : fallbackList;
  } catch { geminiList = fallbackList; }
  return { claude, gemini: geminiList };
}

export function modelStatus() {
  return {
    roles: (Object.keys(ROLE_MODEL) as Role[]).map((role) => ({ role, name: ROLE_NAME[role], model: ROLE_MODEL[role], down: down.get(role) ?? null })),
    plan: planStatus(),
    routes: { plan: planAvailable(), anthropicKey: Boolean(process.env.ANTHROPIC_API_KEY?.trim()), geminiKey: Boolean(geminiKey()) },
  };
}
