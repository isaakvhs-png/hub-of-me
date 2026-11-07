import { KNOBS } from "../knobs.js";
import { allowanceUsed } from "./ai.js";
import { emit } from "./bus.js";
import { iso, json, lastHisMessageAt, sid } from "./store.js";
import { logStep, type Ctx, type RunCtx } from "./steps.js";

/**
 * The run queue (BUILD_SPEC §5.5). Every piece of work is a row in `runs`, with a trigger and a purpose. A small
 * scheduler in code starts the next one; one model call at a time. Isaak's turn jumps the queue. A background run
 * finishes its current call, saves where it left off, and resumes once he has been quiet (knob).
 */
export type Trigger = "you" | "schedule" | "upkeep" | "review";
export type Job = "reply" | "own" | "upkeep" | "file_conversation" | "review" | "revision" | "discuss";

export interface Run {
  id: string; trigger: Trigger; job: Job; purpose: string; priority: number; dueAt: string | null; startedAt: string | null; endedAt: string | null;
  status: "queued" | "running" | "paused" | "done" | "failed"; leftOff: string; parentGoalId: string | null; input: Record<string, unknown>; error: string; why: string; createdAt: string;
}

const mapRun = (r: Record<string, unknown>): Run => ({
  id: String(r.id), trigger: String(r.trigger) as Trigger, job: String(r.job) as Job, purpose: String(r.purpose), priority: Number(r.priority),
  dueAt: r.due_at == null ? null : iso(r.due_at), startedAt: r.started_at == null ? null : iso(r.started_at), endedAt: r.ended_at == null ? null : iso(r.ended_at),
  status: String(r.status) as Run["status"], leftOff: String(r.left_off ?? ""), parentGoalId: r.parent_goal_id == null ? null : String(r.parent_goal_id),
  input: json(r.input, {}), error: String(r.error ?? ""), why: String(r.why ?? ""), createdAt: iso(r.created_at),
});

export async function enqueue(ctx: Ctx, run: { trigger: Trigger; job: Job; purpose: string; why?: string; priority?: number; dueAt?: string | null; input?: Record<string, unknown>; parentGoalId?: string | null }): Promise<Run> {
  const runId = sid();
  const priority = run.priority ?? (run.trigger === "you" ? 100 : run.trigger === "review" ? 20 : run.trigger === "schedule" ? 10 : 0);
  await ctx.db.query(`INSERT INTO runs (id, user_id, trigger, job, purpose, why, priority, due_at, status, input, parent_goal_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11)`,
    [runId, ctx.userId, run.trigger, run.job, run.purpose.slice(0, 500), run.why ?? "", priority, run.dueAt ?? null, JSON.stringify(run.input ?? {}), run.parentGoalId ?? null, ctx.now().toISOString()]);
  emit(ctx.userId, { type: "run", runId, status: "queued", trigger: run.trigger, job: run.job, purpose: run.purpose });
  return (await getRun(ctx, runId))!;
}

export async function getRun(ctx: Ctx, runId: string): Promise<Run | null> {
  const r = await ctx.db.query(`SELECT * FROM runs WHERE user_id=$1 AND id=$2`, [ctx.userId, runId]);
  return r.rows[0] ? mapRun(r.rows[0]) : null;
}

export async function listRuns(ctx: Ctx, opts: { limit?: number; status?: string[]; since?: string } = {}): Promise<Run[]> {
  const params: unknown[] = [ctx.userId];
  let where = "user_id=$1 AND archived_at IS NULL";
  if (opts.status) { params.push(opts.status); where += ` AND status = ANY($${params.length}::text[])`; }
  if (opts.since) { params.push(opts.since); where += ` AND created_at >= $${params.length}`; }
  params.push(opts.limit ?? 100);
  const r = await ctx.db.query(`SELECT * FROM runs WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return r.rows.map(mapRun);
}

async function setStatus(ctx: Ctx, run: Run, status: Run["status"], patch: { leftOff?: string; error?: string } = {}): Promise<void> {
  const now = ctx.now().toISOString();
  await ctx.db.query(
    `UPDATE runs SET status=$3, started_at=COALESCE(started_at, CASE WHEN $3='running' THEN $4::timestamptz END), ended_at=CASE WHEN $3 IN ('done','failed') THEN $4::timestamptz ELSE ended_at END,
     left_off=COALESCE($5, left_off), error=COALESCE($6, error) WHERE user_id=$1 AND id=$2`,
    [ctx.userId, run.id, status, now, patch.leftOff ?? null, patch.error ?? null],
  );
  emit(ctx.userId, { type: "run", runId: run.id, status, trigger: run.trigger, job: run.job, purpose: run.purpose });
}

/** Thrown inside a background run when Isaak speaks: the run saves where it was and waits. */
export class Pause extends Error {
  constructor(public leftOff: string) { super("paused for Isaak"); }
}

export type JobHandler = (ctx: RunCtx, run: Run) => Promise<void>;
const handlers = new Map<Job, JobHandler>();
export function registerJob(job: Job, handler: JobHandler): void { handlers.set(job, handler); }

async function youWaiting(ctx: Ctx): Promise<boolean> {
  const r = await ctx.db.query(`SELECT 1 FROM runs WHERE user_id=$1 AND trigger='you' AND status='queued' AND archived_at IS NULL LIMIT 1`, [ctx.userId]);
  return r.rows.length > 0;
}

/**
 * Background work (upkeep, own time, reviews) may use only a share of the weekly allowance (knob) and slows as use
 * rises; Isaak's turns always go first. Returns why it must wait, or null.
 */
export function backgroundBlocked(): string | null {
  const used = allowanceUsed();
  if (used == null) return null;
  if (used >= KNOBS.backgroundShareOfWeek) return `the plan is ${Math.round(used * 100)}% used; background work stops at ${Math.round(KNOBS.backgroundShareOfWeek * 100)}%`;
  return null;
}

async function quietEnough(ctx: Ctx): Promise<boolean> {
  const last = await lastHisMessageAt(ctx);
  if (!last) return true;
  return ctx.now().getTime() - last.getTime() >= KNOBS.resumeAfterQuietMin * 60_000;
}

let running = new Map<string, Promise<void>>();

/** Pick the next run that may start now. Isaak first; background only when he has been quiet and the allowance allows. */
export async function nextRun(ctx: Ctx): Promise<Run | null> {
  const now = ctx.now().toISOString();
  const r = await ctx.db.query(
    `SELECT * FROM runs WHERE user_id=$1 AND archived_at IS NULL AND status IN ('queued','paused') AND (due_at IS NULL OR due_at <= $2)
     ORDER BY (trigger='you') DESC, priority DESC, COALESCE(due_at, created_at) ASC LIMIT 20`, [ctx.userId, now]);
  const candidates = r.rows.map(mapRun);
  const mine = candidates.find((c) => c.trigger === "you");
  if (mine) return mine;
  if (!candidates.length) return null;
  if (!(await quietEnough(ctx))) {
    // While he is talking, background work waits for quiet; a due run (a promise, the nightly review) never waits more than an hour.
    const late = candidates.find((c) => c.dueAt && ctx.now().getTime() - new Date(c.dueAt).getTime() > 60 * 60_000);
    if (!late) return null;
    return late;
  }
  if (backgroundBlocked()) return null;
  return candidates[0];
}

/** Run one queued run to its end (or its pause). Every run's record is in run_steps. */
export async function runOne(ctx: Ctx, run: Run): Promise<void> {
  const handler = handlers.get(run.job);
  const rctx: RunCtx = { ...ctx, runId: run.id };
  await setStatus(ctx, run, "running");
  if (run.status === "paused") await logStep(rctx, { node: "queue/resume", kind: "event", label: `Resumed after quiet: ${run.purpose}`, detail: { leftOff: run.leftOff } });
  try {
    if (!handler) throw new Error(`No handler for job ${run.job}`);
    await handler(rctx, { ...run, status: "running" });
    await setStatus(ctx, run, "done");
  } catch (error) {
    if (error instanceof Pause) {
      await logStep(rctx, { node: "queue/pause", kind: "event", label: "Isaak spoke: paused, saved where it was", detail: { leftOff: error.leftOff } });
      await setStatus(ctx, run, "paused", { leftOff: error.leftOff });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await setStatus(ctx, run, "failed", { error: message.slice(0, 2000) });
  }
}

/** Between calls, a background run asks: has Isaak spoken? If so it pauses here, with where it was. */
export async function checkpoint(ctx: RunCtx, leftOff: () => unknown): Promise<void> {
  const run = await getRun(ctx, ctx.runId);
  if (!run || run.trigger === "you") return;
  if (await youWaiting(ctx)) throw new Pause(JSON.stringify(leftOff()));
}

/**
 * The scheduler's tick: start the next run if none is running for this user. Returns the started run's promise (wrapped).
 * One run per user at a time; Isaak's run does not wait for a background run to finish its whole job, only its call.
 */
export async function tick(ctx: Ctx): Promise<{ work: Promise<void> } | null> {
  const busy = running.get(ctx.userId);
  const next = await nextRun(ctx);
  if (!next) return null;
  if (busy && next.trigger !== "you") return null;
  if (busy && next.trigger === "you") {
    const r = await ctx.db.query(`SELECT 1 FROM runs WHERE user_id=$1 AND trigger='you' AND status='running' LIMIT 1`, [ctx.userId]);
    if (r.rows.length) return null;
  }
  await ctx.db.query(`UPDATE runs SET status='running' WHERE id=$1 AND status IN ('queued','paused')`, [next.id]);
  const work = runOne(ctx, next).finally(() => { if (running.get(ctx.userId) === work) running.delete(ctx.userId); });
  running.set(ctx.userId, work);
  return { work }; // wrapped: awaiting tick() must not wait for the run itself
}

/** Run everything that may run now, one after another (tests and the bench use this instead of the clock). */
export async function drain(ctx: Ctx, max = 50): Promise<number> {
  let n = 0;
  for (; n < max; n += 1) {
    const started = await tick(ctx);
    if (!started) {
      const busy = running.get(ctx.userId);
      if (!busy) break;
      await busy;
      continue;
    }
    await started.work;
  }
  return n;
}

export function resetQueueForTests(): void { running = new Map(); }

/** A heartbeat row every minute: gaps show when the server slept (Render's free tier). */
export async function heartbeat(ctx: Ctx, commit = ""): Promise<void> {
  await ctx.db.query(`INSERT INTO heartbeat (id, user_id, at, commit_sha) VALUES ($1,$2,$3,$4)`, [sid(), ctx.userId, ctx.now().toISOString(), commit]);
}

/** Runs left "running" by a restart are put back in the queue, so nothing is stuck. */
export async function recoverStuck(ctx: Ctx): Promise<number> {
  const r = await ctx.db.query(`UPDATE runs SET status='paused', left_off=COALESCE(NULLIF(left_off,''), '{"restart":true}') WHERE user_id=$1 AND status='running' RETURNING id`, [ctx.userId]);
  return r.rows.length;
}
