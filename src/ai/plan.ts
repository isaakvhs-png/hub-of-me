import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AiRequest, ProviderUsage } from "./types.js";
import { classifyClaudeFailure, ClaudeOverloadedError, modelFamily, type ClaudeFailure, type ClaudeLimitScope } from "./claudeFailure.js";

export { classifyClaudeFailure, ClaudeOverloadedError, modelFamily, parseResetsAt } from "./claudeFailure.js";

/**
 * The plan route: Claude models through a Claude plan (for now Isaak's own Pro plan, shared; 5 Nov), via the Claude Agent SDK, instead
 * of the pay-per-token API. Anthropic's help page "Use the Claude Agent SDK with your Claude plan" (updated Oct 2026)
 * says Agent SDK use signed in with a plan draws from that plan's limits. Isaak chose this on 5 Nov 2026: a fixed
 * monthly price instead of paying per call. It is on when CLAUDE_CODE_OAUTH_TOKEN is set (made with `claude setup-token`).
 *
 * Each call starts the Claude Code program the SDK ships with, with no tools (except web search when asked), no
 * settings from disk and no saved session: one prompt in, one answer out.
 */

export const planAvailable = () => Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
/** Claude can be reached at all: through the plan or through an API key. */
export const claudeAvailable = () => planAvailable() || Boolean(process.env.ANTHROPIC_API_KEY?.trim());

/** What the plan last said about its limits (5-hour window, weekly), for the Health page and for pacing. */
export interface PlanStatus { status: string; type: string; utilization: number | null; resetsAt: string | null; at: string }
let lastStatus: PlanStatus | null = null;
let limitedUntil = 0;
const familyUntil: Record<Exclude<ClaudeLimitScope, "plan">, number> = { sonnet: 0, opus: 0, haiku: 0 };
export const planStatus = () => lastStatus;
function familyUntilOf(model?: string): number {
  if (!model) return 0;
  const fam = modelFamily(model);
  return fam === "plan" ? 0 : familyUntil[fam];
}
/** True while the plan (or, if a model is given, that model's family) is out of allowance; calls then go to the fallback without trying it. */
export const planLimited = (model?: string) => Date.now() < Math.max(limitedUntil, familyUntilOf(model));
export const planLimitedUntil = (model?: string) => {
  const until = Math.max(limitedUntil, familyUntilOf(model));
  return Date.now() < until ? new Date(until).toISOString() : null;
};

export class PlanLimitError extends Error {}

function applyAllowance(failure: ClaudeFailure, fallbackMs = 15 * 60 * 1000): void {
  const until = failure.resetsAt ?? Date.now() + fallbackMs;
  if (failure.scope === "plan") limitedUntil = Math.max(limitedUntil, until);
  else familyUntil[failure.scope] = Math.max(familyUntil[failure.scope], until);
}

function applyRejectedEvent(type: string, resetsAtMs: number): void {
  const t = type.toLowerCase();
  if (t.includes("opus")) familyUntil.opus = Math.max(familyUntil.opus, resetsAtMs);
  else if (t.includes("sonnet")) familyUntil.sonnet = Math.max(familyUntil.sonnet, resetsAtMs);
  else if (t.includes("haiku")) familyUntil.haiku = Math.max(familyUntil.haiku, resetsAtMs);
  else limitedUntil = Math.max(limitedUntil, resetsAtMs);
}

// One call at a time: each call is a separate program, and the free server has little memory. The chat goes first:
// a waiting chat call is taken before waiting work calls, so his answer doesn't sit behind a long project round.
const waiting: { priority: number; run: () => void }[] = [];
let busy = false;
function pump() {
  if (busy || !waiting.length) return;
  waiting.sort((a, b) => b.priority - a.priority);
  const next = waiting.shift()!;
  busy = true;
  next.run();
}
function oneAtATime<T>(fn: () => Promise<T>, priority = 0): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    waiting.push({ priority, run: () => { fn().then(resolve, reject).finally(() => { busy = false; pump(); }); } });
    pump();
  });
}

type QueryFn = (params: { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>;
let injected: QueryFn | null = null;
/** Tests swap the SDK for a fake. */
export function setPlanQueryForTests(fn: QueryFn | null) { injected = fn; }

/**
 * One rate_limit_event, as the SDK forwards it. `utilization` is often missing on the top level (the CLI only
 * puts it there near a warning) while `unifiedWindows` still carries each window's percent. Reading only the
 * top level dropped that percent, so a 7-day limit showed a reset time and "usage unknown". A later event for
 * the same window that omits the percent does not wipe one we already have.
 */
export interface PlanRateInfo {
  status?: string;
  rateLimitType?: string;
  utilization?: number | null;
  resetsAt?: number | null;
  unifiedWindows?: Record<string, { utilization?: number | null; resetsAt?: number | null } | null> | null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function bucketNumber(info: PlanRateInfo, type: string): number | null {
  const windows = info.unifiedWindows;
  if (!windows || typeof windows !== "object" || !type) return null;
  const keys = [type, type.replace(/-/g, "_"), type.replace(/_/g, "-")];
  for (const key of keys) {
    const bucket = windows[key];
    if (!bucket || typeof bucket !== "object") continue;
    const n = asNumber(bucket.utilization);
    if (n != null) return n;
  }
  return null;
}

export function notePlanRateLimit(raw: PlanRateInfo | null | undefined): void {
  if (!raw) return;
  const type = raw.rateLimitType ?? "";
  const fromEvent = asNumber(raw.utilization) ?? bucketNumber(raw, type);
  const prev = lastStatus;
  const sameWindow = Boolean(prev && (prev.type || "") === type && prev.utilization != null);
  const utilization = fromEvent ?? (sameWindow ? prev!.utilization : null);
  const resetsSec = typeof raw.resetsAt === "number" && !Number.isNaN(raw.resetsAt) ? raw.resetsAt : null;
  const resetsAt = resetsSec != null ? new Date(resetsSec * 1000).toISOString() : (sameWindow ? prev!.resetsAt : null);
  lastStatus = { status: raw.status ?? "", type, utilization, resetsAt, at: new Date().toISOString() };
  if (raw.status === "rejected") applyRejectedEvent(type, resetsSec != null ? resetsSec * 1000 : Date.now() + 60 * 60 * 1000);
}

/** Tests set or clear the in-memory plan-limit state (not persisted; the real values come from rate_limit_event). */
export function setPlanLimitForTests(untilMs: number | null, status?: PlanStatus | null): void {
  limitedUntil = untilMs ?? 0;
  familyUntil.sonnet = 0;
  familyUntil.opus = 0;
  familyUntil.haiku = 0;
  if (arguments.length >= 2) lastStatus = status ?? null;
}

/** Tests set a per-family allowance (Sonnet / Opus / Haiku) without limiting the whole plan. */
export function setPlanFamilyLimitForTests(scope: Exclude<ClaudeLimitScope, "plan">, untilMs: number | null): void {
  familyUntil[scope] = untilMs ?? 0;
}

async function loadQuery(): Promise<QueryFn> {
  if (injected) return injected;
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as { query: QueryFn };
  return sdk.query;
}

/** The conversation as one prompt: the SDK takes one user turn, so earlier turns (a JSON retry, say) are written out. */
function flatten(req: AiRequest): string {
  if (req.messages.length === 1) return req.messages[0].content;
  return req.messages
    .map((m, i) => (i === req.messages.length - 1 ? m.content : `${m.role === "assistant" ? "YOUR EARLIER ANSWER" : "EARLIER MESSAGE"}:\n${m.content}\nEND`))
    .join("\n\n");
}

const workDir = () => {
  const dir = path.join(os.tmpdir(), "rings-plan");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

export async function planComplete(req: AiRequest & { model: string }): Promise<{ text: string; usage: ProviderUsage; stopReason: string | null }> {
  if (planLimited(req.model)) {
    const until = planLimitedUntil(req.model) ?? new Date(limitedUntil).toISOString();
    throw new PlanLimitError(`The plan's allowance is used up until ${until}.`);
  }
  return oneAtATime(async () => {
    const query = await loadQuery();
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "hub-rings/0.1" };
    // An API key in the environment would win over the plan and bill per token without anyone noticing.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const system = req.structured ? `${req.system}\n\nReturn exactly one JSON object and nothing else.` : req.system;
    const prompt = flatten(req);
    const promptInput: string | AsyncIterable<unknown> = req.images?.length
      ? (async function* () {
          yield {
            type: "user",
            parent_tool_use_id: null,
            message: { role: "user", content: [...req.images!.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } })), { type: "text", text: prompt }] },
          };
        })()
      : prompt;
    const tools = req.webSearch ? ["WebSearch", "WebFetch"] : [];
    let text = "";
    let result: Record<string, unknown> | null = null;
    for await (const message of query({
      prompt: promptInput,
      options: {
        model: req.model,
        systemPrompt: req.webSearch ? `${system}\n\nEnd with a list headed SOURCES: one line per page you used, "title — url".` : system,
        tools,
        allowedTools: tools,
        maxTurns: req.webSearch ? 8 : 1,
        settingSources: [],
        persistSession: false,
        cwd: workDir(),
        env,
        ...(req.onDelta ? { includePartialMessages: true } : {}),
      },
    })) {
      if (message.type === "rate_limit_event") notePlanRateLimit((message.rate_limit_info ?? null) as PlanRateInfo | null);
      if (message.type === "assistant") {
        const error = message.error as string | undefined;
        // 529 is reported as error: 'overloaded' (SDK 0.3.150+). That is capacity, not allowance — do not set the timer.
        if (error === "billing_error") limitedUntil = Math.max(limitedUntil, Date.now() + 15 * 60 * 1000);
        else if (error === "rate_limit") limitedUntil = Math.max(limitedUntil, Date.now() + 15 * 60 * 1000);
        const content = ((message.message as { content?: { type: string; text?: string }[] })?.content ?? []);
        for (const block of content) if (block.type === "text" && block.text) text = block.text; // the last text is the answer
      }
      if (message.type === "stream_event" && req.onDelta) {
        const event = message.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) req.onDelta(event.delta.text);
      }
      if (message.type === "result") result = message;
    }
    if (!result) throw new Error("The plan call ended without a result.");
    const usage = (result.usage ?? {}) as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    if (result.subtype !== "success" || result.is_error) {
      const why = [String(result.result ?? ""), ...((result.errors as string[] | undefined) ?? [])].filter(Boolean).join(" ").slice(0, 400) || String(result.subtype);
      const classified = classifyClaudeFailure(why);
      if (classified.kind === "limited") {
        applyAllowance(classified);
        throw new PlanLimitError(`Plan: ${why}`);
      }
      if (planLimited(req.model)) throw new PlanLimitError(`Plan: ${why}`);
      if (classified.kind === "overloaded") throw new ClaudeOverloadedError(`Plan: ${why}`);
      throw new Error(`Plan call failed: ${why}`);
    }
    return {
      text: String(result.result ?? text),
      usage: {
        inputTokens: Number(usage.input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens ?? 0),
        cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
        cacheWriteTokens: Number(usage.cache_creation_input_tokens ?? 0),
      },
      stopReason: result.stop_reason ? String(result.stop_reason) : null,
    };
  }, req.priority ?? 0);
}
