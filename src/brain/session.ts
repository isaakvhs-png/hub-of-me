import { z } from "zod";
import type { Db } from "../db.js";
import type { Router } from "../ai/router.js";
import { completeJson } from "../ai/tracked.js";
import { addMessage, getSoul, logAction } from "../repo.js";
import { sectionBody } from "../soul.js";
import { useTool } from "../agent/turn.js";
import { BRAIN_TOOLS } from "./tools.js";
import { brainModel } from "./intake.js";
import { activate } from "./spread.js";
import { learnFromUse, listBricks, listEntries, listLinks, markRevisited } from "./store.js";
import { brainView } from "./view.js";

/**
 * A work session: its own time. Code decides that it happens (here: when he presses "Explore now"; later on a rhythm).
 * The model decides what to do with it: it states a goal, then works step by step, each step rereading the session so far,
 * until it reaches a satisfying point or the spending cap. It must close something or say why it couldn't.
 */

export const SESSION_CAP_EUR_CENTS = Number(process.env.SESSION_CAP_EUR_CENTS ?? 50);
const MAX_STEPS = 16;
const LOG_RESULT_CHARS = 3500;

const asStr = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));
const toolUse = z.object({ what: z.preprocess(asStr, z.string()).optional(), why: z.preprocess(asStr, z.string()).optional(), tool: z.string(), input: z.record(z.any()).optional() });
const stepSchema = z.preprocess(
  (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {}),
  z.object({
    goal: z.preprocess(asStr, z.string()).optional(),
    thought: z.preprocess(asStr, z.string()).optional(),
    think: z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && typeof (x as { tool?: unknown }).tool === "string") : v && typeof v === "object" ? [v] : []), z.array(toolUse)).optional(),
    used: z.preprocess((v) => (Array.isArray(v) ? v.map(String) : []), z.array(z.string())).optional(),
    done: z.preprocess((v) => v === true || v === "true", z.boolean()).optional(),
    wins: z.preprocess(asStr, z.string()).optional(),
    left_off: z.preprocess(asStr, z.string()).optional(),
    bring: z.preprocess(asStr, z.string()).optional(),
  }),
);

const SESSION_TOOLS = [
  ...BRAIN_TOOLS,
  { name: "search", description: "Search the public web; Claude Haiku reads the pages and reports. input: { query }. Never put his private details in a query. Public professional information about people in his working world (role, workplace, a public work email) is fine to look up; private details never." },
  { name: "calendar", description: "His calendar. input: { action: \"add\", title, starts_at, ends_at (ISO with timezone), why } or { action: \"move\", id, starts_at, ends_at } or { action: \"archive\", id, why }." },
];

function sessionPrompt(name: string, nature: string, boundaries: string): string {
  return `TASK: session
This is your own time. ${name} is not here and has not asked for anything right now. Code gave you this session because that is your rhythm; what you do with it is yours.

YOUR NATURE (his lines):
${nature}

YOUR BOUNDARIES (his lines):
${boundaries}

How a session goes:
1. First step: say in "goal" what you want to achieve in this session and why: from your agenda, your curiosity, or the random revisit.
2. Then work step by step. Each step you see the whole session so far. Decide the next move from what you just found. You can open bricks and sources, search the web, make bricks for what you find or think, add entries, lay links (an "insight" link with its reason when two far-apart things turn out to matter for each other), close questions and agenda items, add to your agenda, and put things in his calendar.
3. Anything that would reach another person (a message, an intro, an application) is saved as a "suggestion" on your agenda for him to decide on. Then keep going.
4. Close what you can. A session should end with something concretely closed or made, or say why it couldn't.
5. The random revisit is guaranteed a look: compare it with what is warm or open right now. If it matters now, link it with the reason and follow it.
6. Stop when you reach a satisfying point: set done true, wins (what you closed or made), left_off (where to pick up next time), and optionally bring: one short thing worth telling him when he's back (only if it really is worth his time).

Every step, return one JSON object: {"goal":"","thought":"what you think now","think":[{"what":"","why":"","tool":"","input":{}}],"used":["brick ids you actually used in this step's thinking"],"done":false,"wins":"","left_off":"","bring":""}

TOOLS:
${SESSION_TOOLS.map((t) => `${t.name}: ${t.description}`).join("\n")}`;
}

async function sessionCost(db: Db, sessionId: string): Promise<number> {
  const row = (await db.query(`SELECT COALESCE(SUM(cost_eur_cents), 0) AS c FROM usage_records WHERE job_id = $1`, [sessionId])).rows[0];
  return Number(row?.c ?? 0);
}

/** What it can choose from, assembled by code: his jobs, its pursuits, open questions, thin spots, and one guaranteed random revisit. */
async function candidates(db: Db, userId: string): Promise<{ text: string; revisit: string | null }> {
  const [bricks, links, entries] = await Promise.all([listBricks(db, userId), listLinks(db, userId), listEntries(db, userId, { status: "open" })]);
  const degree = new Map<string, number>();
  for (const l of links) { degree.set(l.a, (degree.get(l.a) ?? 0) + 1); degree.set(l.b, (degree.get(l.b) ?? 0) + 1); }
  const nameOf = new Map(bricks.map((b) => [b.id, b.name]));
  const questions = entries.filter((e) => e.kind === "question" || e.kind === "lead").slice(0, 10).map((e) => `- open ${e.kind} [${e.id}] on [${e.brickId}] ${nameOf.get(e.brickId) ?? "?"}: ${e.text}`);
  const thin = bricks.filter((b) => b.kind !== "source" && (degree.get(b.id) ?? 0) <= 1).slice(0, 5).map((b) => `- thin spot [${b.id}] ${b.name} (${degree.get(b.id) ?? 0} links)`);
  const quiet = bricks.filter((b) => b.kind !== "source").sort((a, b) => {
    const t = (x: typeof a) => new Date(x.lastRevisitedAt ?? x.lastLitAt ?? x.createdAt).getTime();
    return t(a) - t(b) || Math.random() - 0.5;
  });
  // A little randomness among the quietest, so it doesn't always land on the same one.
  const pick = quiet.slice(0, Math.min(5, quiet.length))[Math.floor(Math.random() * Math.min(5, quiet.length))];
  if (pick) await markRevisited(db, userId, pick.id);
  const text = [
    "WHAT YOU COULD DO (the agenda above comes first; these are what curiosity and the rhythm add):",
    ...(questions.length ? questions : ["- (no open questions or leads)"]),
    ...thin,
    pick ? `- RANDOM REVISIT (guaranteed a look) [${pick.id}] ${pick.name}: quiet since ${(pick.lastRevisitedAt ?? pick.lastLitAt ?? pick.createdAt).slice(0, 16)}` : "",
  ].filter(Boolean).join("\n");
  return { text, revisit: pick?.id ?? null };
}

/** Which session is running right now, per person, so the page can show it like a turn. */
const running = new Map<string, { phase: string; model: string; label: string; since: string }>();
export function sessionNow(userId: string) { return running.get(userId) ?? null; }

export interface SessionResult { sessionId: string; goal: string; wins: string; leftOff: string; steps: number; costEurCents: number; endedWhy: string; bring: string }

export async function runSession(db: Db, ai: Router, userId: string, opts: { capEurCents?: number; onEvent?: (e: { type: string; [k: string]: unknown }) => void | Promise<void> } = {}): Promise<SessionResult> {
  if (running.has(userId)) throw new Error("A work session is already running.");
  running.set(userId, { phase: "Its own time: starting", model: "", label: "", since: new Date().toISOString() });
  const forward = opts.onEvent;
  opts = { ...opts, onEvent: async (e) => {
    const now = running.get(userId);
    if (now && e.type === "thinking") running.set(userId, { ...now, phase: String(e.phase ?? now.phase), model: String(e.model ?? now.model), label: "" });
    if (now && e.type === "work") running.set(userId, { ...now, label: e.status === "running" ? String(e.label ?? "") : "" });
    await forward?.(e);
  } };
  try {
    return await sessionBody(db, ai, userId, opts);
  } finally {
    running.delete(userId);
  }
}

async function sessionBody(db: Db, ai: Router, userId: string, opts: { capEurCents?: number; onEvent?: (e: { type: string; [k: string]: unknown }) => void | Promise<void> }): Promise<SessionResult> {
  const cap = opts.capEurCents ?? SESSION_CAP_EUR_CENTS;
  const sessionId = `ses-${Date.now().toString(36)}`;
  await db.query(`INSERT INTO brain_sessions (id, user_id) VALUES ($1,$2)`, [sessionId, userId]);
  const who = (await db.query(`SELECT name FROM users WHERE id = $1`, [userId])).rows[0];
  const name = String(who?.name ?? "Isaak");
  const soul = await getSoul(db, userId);
  const nature = sectionBody(soul?.content ?? "", "Nature");
  const boundaries = sectionBody(soul?.content ?? "", "Boundaries");
  const model = await brainModel(db, userId, "session");
  const pick = await candidates(db, userId);
  const last = (await db.query(`SELECT left_off FROM brain_sessions WHERE user_id = $1 AND archived_at IS NULL AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1`, [userId])).rows[0];
  const log: { step: number; thought: string; tools: { tool: string; what: string; result: string }[] }[] = [];
  let goal = "", wins = "", leftOff = "", bring = "", endedWhy = "", steps = 0;
  await logAction(db, userId, { what: "work session started", why: "Its own time (Explore now).", source: "session", payload: { sessionId } });
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const spent = await sessionCost(db, sessionId);
    if (spent >= cap) { endedWhy = `spending cap reached (EUR ${(spent / 100).toFixed(2)} of ${(cap / 100).toFixed(2)})`; break; }
    steps = step + 1;
    await opts.onEvent?.({ type: "thinking", phase: step === 0 ? "Its own time: choosing" : "Its own time: working", model });
    // What it is thinking about lights up the web, like his messages do.
    const focusText = [goal, log.at(-1)?.thought ?? "", ...(log.at(-1)?.tools.map((t) => t.result.slice(0, 400)) ?? [])].join("\n");
    const lit = await activate(db, userId, { text: focusText || pick.text, cause: `session ${sessionId} step ${steps}`, extraSeeds: step === 0 && pick.revisit ? [pick.revisit] : [] });
    const view = await brainView(db, userId, { ids: lit.focus, energies: lit.energies });
    const sessionSoFar = log.map((l) => `STEP ${l.step}: ${l.thought}\n${l.tools.map((t) => `  ${t.tool} (${t.what}): ${t.result}`).join("\n")}`).join("\n\n") || "(this is the first step)";
    let decision: z.output<typeof stepSchema>;
    try {
      decision = (await completeJson(db, userId, ai, {
        role: "reflection",
        model,
        maxTokens: 6000,
        cacheSystem: true,
        system: sessionPrompt(name, nature, boundaries),
        messages: [{
          role: "user",
          content: `${view.agenda}\n\n${pick.text}\n\nWHERE YOU LEFT OFF LAST TIME: ${String(last?.left_off ?? "") || "(this is your first session)"}\n\n${view.wall}\n\n${view.focus}\n\nTHIS SESSION SO FAR (spent EUR ${(spent / 100).toFixed(2)} of ${(cap / 100).toFixed(2)}):\n${sessionSoFar}\n\nNow: ${step === 0 ? "say your goal, then take the first step." : "the next step."}${steps >= MAX_STEPS - 1 ? " This is your last step: finish, with done, wins and left_off." : ""}`,
        }],
      }, stepSchema, { jobKind: "session", jobId: sessionId })) as z.output<typeof stepSchema>;
    } catch (error) {
      endedWhy = `a step failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`;
      break;
    }
    if (decision.goal?.trim() && !goal) goal = decision.goal.trim();
    const entry = { step: steps, thought: decision.thought?.trim() || "", tools: [] as { tool: string; what: string; result: string }[] };
    for (const use of decision.think ?? []) {
      if (!SESSION_TOOLS.some((t) => t.name === use.tool)) { entry.tools.push({ tool: use.tool, what: use.what ?? "", result: "(not a tool you have in a session)" }); continue; }
      await opts.onEvent?.({ type: "work", status: "running", label: use.what || use.tool });
      const result = await useTool(db, ai, userId, { tool: use.tool, input: use.input ?? {}, text: "", conversationId: null, userMessageId: null, files: [], notes: [], closed: [], traces: [], model, jobId: sessionId });
      entry.tools.push({ tool: use.tool, what: use.what ?? "", result: result.length > LOG_RESULT_CHARS ? `${result.slice(0, LOG_RESULT_CHARS)}…(cut)` : result });
      await opts.onEvent?.({ type: "work", status: "done", label: use.what || use.tool });
    }
    log.push(entry);
    if (decision.used?.length) await learnFromUse(db, userId, decision.used, lit.focus);
    await db.query(`UPDATE brain_sessions SET goal = $2, log = $3 WHERE id = $1`, [sessionId, goal, JSON.stringify(log)]);
    if (decision.done) {
      wins = decision.wins?.trim() ?? ""; leftOff = decision.left_off?.trim() ?? ""; bring = decision.bring?.trim() ?? "";
      endedWhy = "it reached a satisfying point";
      break;
    }
    if (!decision.think?.length && step > 0) { endedWhy = "it stopped without saying it was done"; break; }
  }
  if (!endedWhy) endedWhy = "step limit reached";
  const cost = await sessionCost(db, sessionId);
  await db.query(`UPDATE brain_sessions SET goal = $2, log = $3, wins = $4, left_off = $5, ended_why = $6, cost_eur_cents = $7, ended_at = now() WHERE id = $1`, [sessionId, goal, JSON.stringify(log), wins, leftOff, endedWhy, cost]);
  await logAction(db, userId, { what: "work session ended", why: `${endedWhy}. Goal: ${goal || "(none)"}. Wins: ${wins || "(none)"}`, source: "session", payload: { sessionId, cost } });
  if (bring) {
    // At most one unasked thing a day reaches the chat; the rest stays in the feed.
    const today = (await db.query(`SELECT 1 FROM action_log WHERE user_id = $1 AND what = 'brought him something' AND created_at > now() - interval '20 hours' LIMIT 1`, [userId])).rows[0];
    const live = (await db.query(`SELECT id FROM conversations WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0];
    if (!today && live) {
      await addMessage(db, String(live.id), "assistant", bring);
      await logAction(db, userId, { what: "brought him something", why: bring.slice(0, 300), source: "session", payload: { sessionId } });
    }
  }
  return { sessionId, goal, wins, leftOff, steps, costEurCents: cost, endedWhy, bring };
}

export async function listSessions(db: Db, userId: string, limit = 10) {
  const rows = (await db.query(`SELECT * FROM brain_sessions WHERE user_id = $1 AND archived_at IS NULL ORDER BY started_at DESC LIMIT $2`, [userId, limit])).rows;
  return rows.map((r) => ({
    id: String(r.id), goal: String(r.goal), wins: String(r.wins), leftOff: String(r.left_off), endedWhy: String(r.ended_why),
    costEurCents: Number(r.cost_eur_cents), startedAt: new Date(String(r.started_at)).toISOString(), endedAt: r.ended_at ? new Date(String(r.ended_at)).toISOString() : null,
    log: (() => { try { return JSON.parse(String(r.log)); } catch { return []; } })(),
  }));
}
