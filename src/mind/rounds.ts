import { z } from "zod";
import type { Db } from "../db.js";
import type { Router } from "../ai/router.js";
import { completeJson, completeText } from "../ai/tracked.js";
import { logAction } from "../repo.js";
import { activate, recordUsed } from "../brain/spread.js";
import { tieredView } from "../brain/view.js";
import { addAgenda, addEntry, createBrick, learnFromUse, linkBricks, listAgenda, listBricks, updateAgendaStep } from "../brain/store.js";
import { agendaText } from "../brain/view.js";
import { intake } from "../brain/intake.js";

/**
 * Thinking in rounds (Isaak, 6 Nov). It thinks first, in plain language, with no list of tools in view: "what would a
 * highly capable person with my memory do here?" Several rounds look at it from different angles, each with what is
 * newly lit. Then it decides. Only after that, a separate step (how) works out what can actually be done now; what only
 * partly fits, or can't be done yet, becomes a design for what it needs (a gap brick), with the situation as evidence.
 * What it concluded is filed into the web like anything he sends, so the web grows from its own thinking too.
 * Every run is kept whole in mind_runs, so what it did and why can be read back round by round.
 */

type Event = { type: string; [key: string]: unknown };

export interface RoundsInput {
  mode: "chat" | "own";
  name: string;
  soul: string;
  boundaries: string;
  situation: string;
  conversation: string;
  seedText: string;
  seedWeights?: Map<string, number>;
  model: string;
  cause: string;
  onEvent?: (e: Event) => void | Promise<void>;
  /** Runs one real action (a "hand"): the same code the older loop's tools use. */
  runHand: (hand: string, input: Record<string, unknown>, jobId: string) => Promise<string>;
}

export interface RoundRecord { n: number; stance: string; lit: { full: string[]; line: number; names: number; edge: string[]; far: string[] }; text: string }
export interface ActRecord { intention: string; fit: string; hand?: string; input?: Record<string, unknown>; stopgap?: boolean; result?: string; gap?: string; suggestion?: string }
export interface MindRun { id: string; say: string; rounds: RoundRecord[]; acts: ActRecord[]; decision: Decision; error: string }

/** Real actions it has now. Everything that only writes to its own memory happens by filing its thinking instead. */
export const HANDS = [
  { name: "search", what: "Search the public web and read the pages; every page is kept as a source.", input: "{ query, why }. Never his private details or anyone's contact details in a query." },
  { name: "open_source", what: "Read a whole file he handed over (listed under FILES below).", input: "{ id } (sXXXX)" },
  { name: "calendar", what: "His calendar: add, move or archive an event.", input: "{ action: \"add\", title, starts_at, ends_at (ISO with timezone), why } | { action: \"move\", id, starts_at, ends_at } | { action: \"archive\", id, why }" },
  { name: "agenda_add", what: "Put something on its own agenda: a pursuit of its own, a job he gave it, or a question for him.", input: "{ kind: \"pursuit\"|\"job\"|\"question\", text, why, next_step }" },
  { name: "agenda_step", what: "Write the next step on an open agenda item.", input: "{ id, next_step }" },
  { name: "agenda_close", what: "Close an agenda item: done, or dropped with a reason.", input: "{ id, status: \"done\"|\"dropped\", note }" },
  { name: "entry_close", what: "Mark an open question answered, a lead followed or a to-do done (listed under OPEN ON LIT BRICKS).", input: "{ id, status: \"answered\"|\"done\"|\"dropped\", note }" },
  { name: "link", what: "Lay an insight link between two bricks that matter for each other, with the reason.", input: "{ a, b, type: \"insight\", reason }" },
  { name: "wake_me", what: "Choose when to wake up and think again on its own while he is away.", input: "{ in_minutes, why }" },
  { name: "look_at_myself", what: "Read how it works (the machinery) or one of its own design files.", input: "{ file? }" },
  { name: "read_records", what: "Read its own records: what it thought and did since the fresh start.", input: "{}" },
] as const;
const HAND_NAMES = new Set<string>(HANDS.map((h) => h.name));
/** Hands whose result is information it should think with before answering. */
const INFORMING = new Set(["search", "open_source", "look_at_myself", "read_records"]);

const MAX_ROUNDS = { chat: 5, own: 6 };
const MAX_ACTS = 8;
const RESULT_CHARS = 6000;

const asStr = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));
const strList = z.preprocess((v) => (Array.isArray(v) ? v.map(asStr).filter((s) => s.trim()) : typeof v === "string" && v.trim() ? [v] : []), z.array(z.string()));
const decisionSchema = z.preprocess(
  (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {}),
  z.object({
    say: z.preprocess(asStr, z.string()).default(""),
    would_do: strList.default([]),
    now_think: z.preprocess(asStr, z.string()).default(""),
    predictions: z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []), z.array(z.object({ claim: z.preprocess(asStr, z.string()), by: z.preprocess(asStr, z.string()).optional(), confidence: z.preprocess((x) => Number(x), z.number()).optional() }))).default([]),
    disagreement: z.preprocess(asStr, z.string()).default(""),
    used: strList.default([]),
    another_round: z.preprocess((v) => (v && typeof v === "object" && !Array.isArray(v) && asStr((v as { stance?: unknown }).stance).trim() ? v : typeof v === "string" && v.trim() ? { stance: v } : null), z.object({ stance: z.preprocess(asStr, z.string()) }).nullable()).default(null),
  }),
);
export type Decision = z.output<typeof decisionSchema>;

const gapSchema = z.object({ ref: z.preprocess(asStr, z.string()).optional(), name: z.preprocess(asStr, z.string()).optional(), what: z.preprocess(asStr, z.string()).optional(), why: z.preprocess(asStr, z.string()).optional(), how: z.preprocess(asStr, z.string()).optional() });
const howSchema = z.preprocess(
  (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : { acts: Array.isArray(v) ? v : [] }),
  z.object({
    acts: z.array(z.object({
      intention: z.preprocess(asStr, z.string()).default(""),
      fit: z.preprocess((v) => asStr(v).toLowerCase().trim(), z.string()).default("none"),
      hand: z.preprocess(asStr, z.string()).optional(),
      input: z.preprocess((v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {}), z.record(z.any())).optional(),
      stopgap: z.preprocess((v) => v === true || v === "true", z.boolean()).optional(),
      gap: z.preprocess((v) => (v && typeof v === "object" ? v : undefined), gapSchema.optional()),
      suggestion: z.preprocess((v) => (v && typeof v === "object" ? v : undefined), z.object({ ref: z.preprocess(asStr, z.string()).optional(), text: z.preprocess(asStr, z.string()).optional(), why: z.preprocess(asStr, z.string()).optional() }).optional()),
    })).default([]),
  }),
);

function roundSystem(input: RoundsInput, agenda: string): string {
  return `TASK: round
You are ${input.name}'s own AI, thinking in rounds before anything is said or done. ${input.mode === "own" ? `This is your own time: ${input.name} is not here and asked for nothing.` : `${input.name} is in the conversation.`}

How this works. Each round is a fresh look, written in plain language: no forms, no menu of tools. Think like a highly capable person who has your memory (the web of bricks), can read and search anything public, keep his calendar and agenda, write drafts, and keep working while he is away, but cannot reach other people without him. Write what you actually think and what you would actually do. Whether you can already do it is worked out after you have decided; what you can't do yet becomes a design for something you need. So don't shrink your thinking to what seems possible.
What you see of the web is what your thinking lights up: the brightest bricks in full, fainter ones shorter, then the edge and a couple of far, quiet bricks. Name a brick or a thing in your thinking and the next round sees it lit.
Judgment, not a checklist: be concrete; use what is in the web and say which; never invent facts about him; mark guesses as guesses; where you can find something out yourself, do that instead of asking him.

SOUL:
${input.soul}

${agenda}`;
}

function stanceText(n: number, stance: string, mode: "chat" | "own"): string {
  const end = `End with a section headed WHAT I WOULD DO: numbered plain sentences, one action each (or "nothing yet, because ...").${mode === "chat" ? " If you would answer him, one of them says what the answer should carry." : ""}`;
  if (stance === "draft") return `ROUND ${n}: FIRST LOOK. What is going on, what matters here, and what would you do? Write freely. ${end}`;
  if (stance === "challenge") return `ROUND ${n}: ANOTHER ANGLE. Read the round(s) above against what is lit now, the far bricks too. Take a real stance: where is it wrong, thin, passive, too safe, or missing a connection across the web or across time? Disagree where it matters, not on everything. ${end}`;
  if (stance === "calibrate") return `ROUND ${n}: CALIBRATE. How sure are you of what the rounds concluded? What would prove it wrong, and what does it cost if it is wrong? Write predictions that can be checked later, each on its own line as PREDICTION: claim | by when | how sure (%). ${end}`;
  return `ROUND ${n}: ${stance} ${end}`;
}

function decideText(final: boolean, roundsLeft: number, mode: "chat" | "own"): string {
  return `${final ? "AFTER ACTING. Above are the results of what was just done. Settle what you now say and think, with those results in hand." : "DECIDE. Weigh the rounds and settle what to do."}
Return one JSON object:
{"say":"","would_do":[],"now_think":"","predictions":[{"claim":"","by":"","confidence":70}],"disagreement":"","used":[],"another_round":null}
- say: what ${mode === "chat" ? "he reads now, in your own words. When he wrote to you, answer him" : "you would bring him when he is back; leave it empty unless it is really worth his time"}.${final ? "" : " If what you would do first needs to happen before you can answer (a search, reading a file), leave say empty: you get one more look after acting."}
- would_do: ${final ? "leave empty; anything still to do goes on your agenda next time." : "the actions you settled on, as plain sentences, one each. Not limited to what you think you can do."}
- now_think: what you now think, in a few plain sentences, to keep in your web: what you concluded, connections you saw, what is still open. It is filed as your own thinking.
- predictions: checkable claims with a date and how sure you are (0 to 100), if any.
- disagreement: what the rounds still disagree on, if anything. Keep it; don't average it away.
- used: ids of the bricks your thinking actually used.
- another_round: ${final || roundsLeft <= 0 ? "null." : `{"stance":"what the next round should look at, and from which angle"} only if one more round would really change what you do (${roundsLeft} left); otherwise null.`}`;
}

async function runCost(db: Db, runId: string): Promise<number> {
  return Number((await db.query(`SELECT COALESCE(SUM(cost_eur_cents), 0) AS c FROM usage_records WHERE job_id = $1`, [runId])).rows[0]?.c ?? 0);
}

async function save(db: Db, runId: string, run: { rounds: RoundRecord[]; decision?: unknown; acts: ActRecord[]; say?: string; error?: string; end?: boolean }): Promise<void> {
  const cost = run.end ? await runCost(db, runId) : 0;
  await db.query(
    `UPDATE mind_runs SET rounds = $2, decision = $3, acts = $4, say = $5, error = $6${run.end ? ", ended_at = now(), cost_eur_cents = $7" : ""} WHERE id = $1`,
    [runId, JSON.stringify(run.rounds), JSON.stringify(run.decision ?? {}), JSON.stringify(run.acts), run.say ?? "", run.error ?? "", ...(run.end ? [cost] : [])],
  );
}

export async function thinkInRounds(db: Db, ai: Router, userId: string, input: RoundsInput): Promise<MindRun> {
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await db.query(`INSERT INTO mind_runs (id, user_id, cause, mode) VALUES ($1,$2,$3,$4)`, [runId, userId, input.cause.slice(0, 300), input.mode]);
  const rounds: RoundRecord[] = [];
  const acts: ActRecord[] = [];
  let decision: Decision = decisionSchema.parse({});
  const used = new Set<string>();
  const litEver = new Set<string>();
  try {
    const agenda = agendaText(await listAgenda(db, userId));
    const system = roundSystem(input, agenda);
    const bricks = await listBricks(db, userId);
    const nameOf = new Map(bricks.map((b) => [b.id, b.name]));
    // First light: what he said (and what was just filed); later rounds light from the last round's own text.
    let lit = await activate(db, userId, { text: input.seedText, cause: input.cause, weights: input.seedWeights });
    const plan = input.mode === "own" ? ["draft", "challenge", "calibrate"] : ["draft", "challenge"];
    const max = MAX_ROUNDS[input.mode];
    let actResults = "";
    const roundsText = () => rounds.map((r) => `--- ROUND ${r.n} (${r.stance}) ---\n${r.text}`).join("\n\n");
    const stepMessage = async (instruction: string) => {
      const view = await tieredView(db, userId, lit.energies);
      for (const k of [...view.full, ...view.line]) litEver.add(k);
      return {
        view,
        content: `${view.text}\n\nCONVERSATION SO FAR:\n${input.conversation}\n\nNOW:\n${input.situation}\n\n${rounds.length ? `THE ROUNDS SO FAR:\n${roundsText()}\n\n` : ""}${actResults ? `WHAT WAS JUST DONE, AND WHAT CAME BACK:\n${actResults}\n\n` : ""}${instruction}`,
      };
    };
    const oneRound = async (stance: string) => {
      const n = rounds.length + 1;
      await input.onEvent?.({ type: "thinking", phase: `Round ${n}: ${stance === "draft" ? "first look" : stance === "challenge" ? "another angle" : stance === "calibrate" ? "calibrating" : "one more look"}`, model: input.model });
      const { view, content } = await stepMessage(stanceText(n, stance, input.mode));
      const text = (await completeText(db, userId, ai, { role: input.mode === "own" ? "reflection" : "conversation", model: input.model, maxTokens: 4000, cacheSystem: true, system, messages: [{ role: "user", content }] }, { jobKind: "mind", jobId: runId })).trim();
      rounds.push({ n, stance, lit: { full: view.full.map((k) => nameOf.get(k) ?? k), line: view.line.length, names: view.names.length, edge: view.edge.map((k) => nameOf.get(k) ?? k), far: view.far.map((k) => nameOf.get(k) ?? k) }, text });
      await save(db, runId, { rounds, acts });
      // Re-light from what this round thought, with the last focus carried on at half strength so the thread continues.
      const carry = new Map<string, number>();
      for (const k of view.full) carry.set(k, (lit.energies.get(k) ?? 0.5) * 0.5);
      for (const k of view.far) if (text.includes(nameOf.get(k) ?? "\u0000")) carry.set(k, 1);
      lit = await activate(db, userId, { text, cause: `${input.cause} · round ${n}`, weights: carry });
    };
    const decide = async (final: boolean) => {
      await input.onEvent?.({ type: "thinking", phase: final ? "Settling, with the results" : "Deciding", model: input.model });
      const left = max - rounds.length;
      const { content } = await stepMessage(decideText(final, left, input.mode));
      decision = (await completeJson(db, userId, ai, { role: input.mode === "own" ? "reflection" : "conversation", model: input.model, maxTokens: 4000, cacheSystem: true, system: system.replace("TASK: round", "TASK: decide"), messages: [{ role: "user", content }] }, decisionSchema, { jobKind: "mind", jobId: runId })) as Decision;
      for (const u of decision.used) used.add(u);
      await save(db, runId, { rounds, acts, decision });
    };

    for (const stance of plan) await oneRound(stance);
    await decide(false);
    while (decision.another_round && rounds.length < max) {
      await oneRound(decision.another_round.stance);
      await decide(false);
    }

    if (decision.would_do.length) {
      await input.onEvent?.({ type: "thinking", phase: "Working out how", model: input.model });
      const done = await how(db, ai, userId, runId, input, decision.would_do, lit.focus, acts);
      if (done.informed) {
        actResults = done.results;
        const said = decision.say;
        await decide(true);
        if (!decision.say.trim() && said.trim()) decision.say = said;
      }
    }

    // What it concluded becomes part of the web, marked as its own thinking: the web grows from its thinking too.
    const thought = [decision.now_think.trim(), decision.disagreement.trim() ? `Still open between my rounds: ${decision.disagreement.trim()}` : ""].filter(Boolean).join("\n");
    if (thought) {
      await input.onEvent?.({ type: "thinking", phase: "Filing what it thought", model: "" });
      await intake(db, ai, userId, { text: thought, kind: "own", origin: "own", title: "its own thinking" }).catch(async (error) => {
        await logAction(db, userId, { what: "could not file its own thinking", why: error instanceof Error ? error.message.slice(0, 300) : "unknown", source: "mind", payload: { runId } });
      });
    }
    if (decision.predictions.length) {
      const me = (await listBricks(db, userId)).find((b) => b.kind === "self");
      if (me) for (const p of decision.predictions) if (p.claim.trim()) await addEntry(db, userId, { brickId: me.id, kind: "prediction", text: `${p.claim.trim()}${p.by ? ` (by ${p.by})` : ""}${p.confidence != null && Number.isFinite(p.confidence) ? `, ${Math.round(p.confidence)}% sure` : ""}`, origin: "own", status: "open" });
    }
    const usedList = [...used].filter((u) => nameOf.has(u));
    if (usedList.length) {
      await learnFromUse(db, userId, usedList, [...litEver]);
      await recordUsed(db, userId, usedList);
    }
    await save(db, runId, { rounds, acts, decision, say: decision.say.trim(), end: true });
    await logAction(db, userId, { what: "thought in rounds", why: `${rounds.length} rounds, ${acts.length} acts${acts.some((a) => a.gap) ? `, ${acts.filter((a) => a.gap).length} gaps designed` : ""}`, source: "mind", payload: { runId } });
    return { id: runId, say: decision.say.trim(), rounds, acts, decision, error: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "unknown";
    await save(db, runId, { rounds, acts, decision, error: message, end: true });
    throw error;
  }
}

/** The how step: from plain intentions to what can be done now, strictly graded; the rest becomes designs and suggestions. */
async function how(db: Db, ai: Router, userId: string, runId: string, input: RoundsInput, intentions: string[], focus: string[], acts: ActRecord[]): Promise<{ informed: boolean; results: string }> {
  const [bricks, agenda, sources, events, openEntries] = await Promise.all([
    listBricks(db, userId),
    listAgenda(db, userId, { open: true }),
    db.query(`SELECT id, title FROM brain_sources WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 30`, [userId]),
    db.query(`SELECT id, title, starts_at FROM calendar_events WHERE user_id = $1 AND archived_at IS NULL AND ends_at > now() - interval '1 day' ORDER BY starts_at LIMIT 30`, [userId]),
    focus.length ? db.query(`SELECT id, brick_id, kind, text FROM brick_entries WHERE user_id = $1 AND archived_at IS NULL AND status = 'open' AND brick_id = ANY($2) LIMIT 40`, [userId, focus]) : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
  ]);
  const gaps = bricks.filter((b) => b.kind === "gap").map((b) => ({ id: b.id, name: b.name, summary: b.summary }));
  const nameOf = new Map(bricks.map((b) => [b.id, b.name]));
  const content = `INTENTIONS (what it decided it would do):
${intentions.map((t, i) => `${i + 1}. ${t}`).join("\n")}

HANDS (what can actually be done now):
${HANDS.map((h) => `${h.name}: ${h.what} input: ${h.input}`).join("\n")}

AGENDA (open):
${agenda.map((a) => `[${a.id}] ${a.kind}: ${a.text}`).join("\n") || "(empty)"}

FILES:
${sources.rows.map((r) => `[${r.id}] ${r.title}`).join("\n") || "(none)"}

CALENDAR (upcoming):
${events.rows.map((r) => `[${r.id}] ${new Date(String(r.starts_at)).toISOString()} ${r.title}`).join("\n") || "(empty)"}

OPEN ON LIT BRICKS:
${openEntries.rows.map((r) => `[${r.id}] on ${nameOf.get(String(r.brick_id)) ?? r.brick_id}: ${r.kind}: ${r.text}`).join("\n") || "(none)"}

KNOWN GAPS (designs for what it needs, from earlier):
${gaps.map((g) => `[${g.id}] ${g.name}${g.summary ? `: ${g.summary.slice(0, 140)}` : ""}`).join("\n") || "(none yet)"}

BOUNDARIES (Isaak's):
${input.boundaries}

Now: ${new Date().toISOString()}`;
  const system = `TASK: how
You turn plain intentions into what can actually be done now. You are strict about fit: a hand that only roughly fits is partial, not full.
For each intention, one act:
- fit "full": a hand does exactly what was meant. Give hand and input.
- fit "partial": a hand does only part of it, or does it badly. That counts as a gap: describe the hand that would really do it (gap). If doing the partial part is still useful and safe, also give hand and input and set stopgap true.
- fit "person": it means reaching another person (a message, an intro, an application, a call), spending money, or deciding something only he can decide. It becomes a suggestion for him (suggestion: text, why). If an open suggestion on the agenda already says this, give its id as ref instead.
- fit "none": no hand does it. Describe what would (gap).
- fit "self": it is about how it works itself (its rounds, its web, how bricks are organised, its prompts): a gap describing the change.
- fit "thought": it only means thinking or remembering something; that is already filed from its thinking. No act needed.
A gap: {"ref": an id from KNOWN GAPS if it is the same need, "name": "Needs: ..." (or "Change: ..." for self), "what": what it would do, "why": this situation, "how": how it could work}.
Within the boundaries always. Return {"acts":[{"intention":"","fit":"","hand":"","input":{},"stopgap":false,"gap":null,"suggestion":null}]}`;
  const plan = (await completeJson(db, userId, ai, { role: input.mode === "own" ? "reflection" : "conversation", model: input.model, maxTokens: 4000, system, messages: [{ role: "user", content }] }, howSchema, { jobKind: "mind", jobId: runId })) as z.output<typeof howSchema>;
  const me = bricks.find((b) => b.kind === "self");
  let informed = false;
  const results: string[] = [];
  for (const act of plan.acts.slice(0, MAX_ACTS)) {
    const rec: ActRecord = { intention: act.intention, fit: act.fit };
    const hand = act.hand?.trim() ?? "";
    const doIt = HAND_NAMES.has(hand) && (act.fit === "full" || (act.fit === "partial" && act.stopgap));
    if (doIt) {
      rec.hand = hand; rec.input = act.input ?? {}; rec.stopgap = act.fit === "partial";
      await input.onEvent?.({ type: "work", status: "running", label: act.intention.slice(0, 80) || hand });
      const result = await input.runHand(hand, act.input ?? {}, runId);
      await input.onEvent?.({ type: "work", status: "done", label: act.intention.slice(0, 80) || hand });
      rec.result = result.length > RESULT_CHARS ? `${result.slice(0, RESULT_CHARS)}…(cut)` : result;
      results.push(`${act.intention}${rec.stopgap ? " (stopgap: only part of it)" : ""}\n${hand}: ${rec.result}`);
      if (INFORMING.has(hand)) informed = true;
    } else if (hand && !HAND_NAMES.has(hand) && act.fit === "full") {
      rec.fit = "none"; // named a hand that does not exist: that is a gap, not a fit
    }
    if (act.fit === "person") {
      const s = act.suggestion ?? {};
      const ref = s.ref?.trim();
      const existing = ref ? (await listAgenda(db, userId, { open: true })).find((a) => a.id === ref) : undefined;
      if (existing) {
        await updateAgendaStep(db, userId, existing.id, `Came up again ${new Date().toISOString().slice(0, 10)}: ${(s.why || act.intention).slice(0, 300)}`);
        rec.suggestion = `raised again: ${existing.text}`;
      } else {
        const text = (s.text || act.intention).trim();
        const agendaId = await addAgenda(db, userId, { kind: "suggestion", text, why: s.why || "From its own thinking.", nextStep: "" });
        rec.suggestion = `new suggestion [${agendaId}]: ${text}`;
      }
      results.push(`${act.intention}\n→ a suggestion for him (${rec.suggestion})`);
    }
    if (act.fit === "partial" || act.fit === "none" || act.fit === "self" || rec.fit === "none") {
      const g = act.gap ?? {};
      const ref = g.ref?.trim();
      const known = ref ? gaps.find((x) => x.id === ref) : undefined;
      const evidence = `${new Date().toISOString().slice(0, 10)}: wanted to "${act.intention.slice(0, 300)}"${g.why ? `. ${g.why.slice(0, 300)}` : ""}`;
      if (known) {
        await addEntry(db, userId, { brickId: known.id, kind: "evidence", text: evidence, origin: "own" });
        rec.gap = `more evidence for ${known.name}`;
      } else {
        const self = act.fit === "self";
        const name = (g.name?.trim() || `${self ? "Change" : "Needs"}: ${act.intention.slice(0, 70)}`).slice(0, 120);
        const brickId = await createBrick(db, userId, { name, kind: "gap", origin: "own", summary: (g.what || act.intention).slice(0, 400) });
        if (g.how) await addEntry(db, userId, { brickId, kind: "design", text: g.how, origin: "own" });
        await addEntry(db, userId, { brickId, kind: "evidence", text: evidence, origin: "own" });
        if (me) await linkBricks(db, userId, { a: me.id, b: brickId, type: "about", reason: self ? "a change to how I work" : "something I need and don't have yet", madeBy: "mind" });
        gaps.push({ id: brickId, name, summary: g.what ?? "" });
        rec.gap = `designed: ${name}`;
      }
      results.push(`${act.intention}\n→ can't do this ${act.fit === "partial" ? "properly " : ""}yet (${rec.gap})`);
    }
    acts.push(rec);
  }
  return { informed, results: results.join("\n\n") };
}

export async function listRuns(db: Db, userId: string, limit = 10) {
  const rows = (await db.query(`SELECT * FROM mind_runs WHERE user_id = $1 AND archived_at IS NULL ORDER BY started_at DESC LIMIT $2`, [userId, limit])).rows;
  const parse = (v: unknown, d: unknown) => { try { return JSON.parse(String(v)); } catch { return d; } };
  return rows.map((r) => ({
    id: String(r.id), cause: String(r.cause), mode: String(r.mode), rounds: parse(r.rounds, []), decision: parse(r.decision, {}), acts: parse(r.acts, []),
    say: String(r.say), error: String(r.error), costEurCents: Number(r.cost_eur_cents),
    startedAt: new Date(String(r.started_at)).toISOString(), endedAt: r.ended_at ? new Date(String(r.ended_at)).toISOString() : null,
  }));
}

