import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AiRequest, ProviderUsage } from "./types.js";

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
export const planStatus = () => lastStatus;
/** True while the plan has said it is out of allowance; calls then go to the fallback without trying it. */
export const planLimited = () => Date.now() < limitedUntil;

export class PlanLimitError extends Error {}

// One call at a time: each call is a separate program, and the free server has little memory.
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

type QueryFn = (params: { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>;
let injected: QueryFn | null = null;
/** Tests swap the SDK for a fake. */
export function setPlanQueryForTests(fn: QueryFn | null) { injected = fn; }

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
  const dir = path.join(os.tmpdir(), "hub-plan");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

export async function planComplete(req: AiRequest & { model: string }): Promise<{ text: string; usage: ProviderUsage; stopReason: string | null }> {
  if (planLimited()) throw new PlanLimitError(`The plan's allowance is used up until ${new Date(limitedUntil).toISOString()}.`);
  return oneAtATime(async () => {
    const query = await loadQuery();
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "hub-of-me/0.1" };
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
      },
    })) {
      if (message.type === "rate_limit_event") {
        const info = (message.rate_limit_info ?? {}) as { status?: string; rateLimitType?: string; utilization?: number; resetsAt?: number };
        lastStatus = { status: info.status ?? "", type: info.rateLimitType ?? "", utilization: info.utilization ?? null, resetsAt: info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : null, at: new Date().toISOString() };
        if (info.status === "rejected") limitedUntil = info.resetsAt ? info.resetsAt * 1000 : Date.now() + 60 * 60 * 1000;
      }
      if (message.type === "assistant") {
        const error = message.error as string | undefined;
        if (error === "rate_limit" || error === "billing_error") limitedUntil = Math.max(limitedUntil, Date.now() + 15 * 60 * 1000);
        const content = ((message.message as { content?: { type: string; text?: string }[] })?.content ?? []);
        for (const block of content) if (block.type === "text" && block.text) text = block.text; // the last text is the answer
      }
      if (message.type === "result") result = message;
    }
    if (!result) throw new Error("The plan call ended without a result.");
    const usage = (result.usage ?? {}) as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    if (result.subtype !== "success" || result.is_error) {
      const why = [String(result.result ?? ""), ...((result.errors as string[] | undefined) ?? [])].filter(Boolean).join(" ").slice(0, 400) || String(result.subtype);
      if (/limit|rate|quota|usage/i.test(why) || planLimited()) throw new PlanLimitError(`Plan: ${why}`);
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
  });
}
