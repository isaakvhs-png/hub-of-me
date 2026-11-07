import { KNOBS } from "../knobs.js";
import { enqueue, heartbeat, tick } from "./queue.js";
import { getMeta, lastHisMessageAt, setMeta } from "./store.js";
import type { Ctx } from "./steps.js";
import { backlog } from "./upkeep.js";
import { listGoals } from "./workshop.js";

/**
 * Rhythm by code (BUILD_SPEC §2): what gets queued when, without a model deciding. Called every minute (and by tests).
 * - a heartbeat row;
 * - the conversation filed once Isaak has gone quiet;
 * - upkeep when something is stale, dated or due for a spot-check, at most every upkeepEveryMin;
 * - own time for open goals with nothing scheduled, at most every ownTimeEveryMin;
 * - the nightly review at 23:30 (Europe/Amsterdam), with the weekly look-back on Sundays.
 */
export function amsterdam(now: Date): { date: string; hhmm: string; weekday: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${parts.hour}:${parts.minute}`, weekday };
}

async function queuedOrRunning(ctx: Ctx, job: string): Promise<boolean> {
  const r = await ctx.db.query(`SELECT 1 FROM runs WHERE user_id=$1 AND job=$2 AND status IN ('queued','running','paused') AND archived_at IS NULL LIMIT 1`, [ctx.userId, job]);
  return r.rows.length > 0;
}

async function minutesSinceLast(ctx: Ctx, where: string, params: unknown[]): Promise<number> {
  const r = await ctx.db.query<{ at: unknown }>(`SELECT max(created_at) AS at FROM runs WHERE user_id=$1 AND ${where}`, [ctx.userId, ...params]);
  const at = r.rows[0]?.at;
  if (!at) return Infinity;
  return (ctx.now().getTime() - new Date(String(at instanceof Date ? at.toISOString() : at)).getTime()) / 60_000;
}

export async function rhythm(ctx: Ctx, opts: { beat?: boolean; commit?: string } = {}): Promise<string[]> {
  const queued: string[] = [];
  if (opts.beat !== false) await heartbeat(ctx, opts.commit ?? "");
  const now = ctx.now();
  const last = await lastHisMessageAt(ctx);
  const quiet = !last || now.getTime() - last.getTime() >= KNOBS.resumeAfterQuietMin * 60_000;

  const unfiled = await ctx.db.query(`SELECT 1 FROM stream WHERE user_id=$1 AND filed_at IS NULL AND kind IN ('his','its') AND archived_at IS NULL LIMIT 1`, [ctx.userId]);
  if (quiet && unfiled.rows.length && !(await queuedOrRunning(ctx, "file_conversation"))) {
    await enqueue(ctx, { trigger: "upkeep", job: "file_conversation", purpose: "File the conversation since the last filing", why: "Isaak has gone quiet" });
    queued.push("file_conversation");
  }

  const a = amsterdam(now);
  const dueEntries = await ctx.db.query(`SELECT 1 FROM entries WHERE user_id=$1 AND status='open' AND due_at < $2 AND archived_at IS NULL LIMIT 1`, [ctx.userId, now.toISOString()]);
  const spotDone = (await getMeta(ctx, `spotcheck:${ctx.userId}`)) === now.toISOString().slice(0, 10);
  const pagesExist = (await ctx.db.query(`SELECT 1 FROM pages WHERE user_id=$1 AND archived_at IS NULL LIMIT 1`, [ctx.userId])).rows.length > 0;
  if (((await backlog(ctx)) > 0 || dueEntries.rows.length || (pagesExist && !spotDone)) && !(await queuedOrRunning(ctx, "upkeep")) && (await minutesSinceLast(ctx, `job='upkeep'`, [])) >= KNOBS.upkeepEveryMin) {
    await enqueue(ctx, { trigger: "upkeep", job: "upkeep", purpose: "Upkeep: stale pages, dates passed, spot-checks, candidates", why: "something is stale or due" });
    queued.push("upkeep");
  }

  for (const goal of await listGoals(ctx, true)) {
    const pending = await ctx.db.query(`SELECT 1 FROM runs WHERE user_id=$1 AND parent_goal_id=$2 AND status IN ('queued','running','paused') LIMIT 1`, [ctx.userId, goal.id]);
    if (pending.rows.length) continue;
    if ((await minutesSinceLast(ctx, `parent_goal_id=$2`, [goal.id])) < KNOBS.ownTimeEveryMin) continue;
    await enqueue(ctx, { trigger: "schedule", job: "own", purpose: `Take the next step on your goal: ${goal.text}`, why: goal.why, parentGoalId: goal.id });
    queued.push(`own:${goal.id}`);
  }

  if (a.hhmm >= KNOBS.nightlyReviewAt && (await getMeta(ctx, `review:${ctx.userId}`)) !== a.date) {
    await setMeta(ctx, `review:${ctx.userId}`, a.date);
    await enqueue(ctx, { trigger: "review", job: "review", purpose: a.weekday === 0 ? "The nightly review and the weekly look-back" : "The nightly review", why: `${KNOBS.nightlyReviewAt} Europe/Amsterdam`, input: { weekly: a.weekday === 0 } });
    queued.push("review");
  }
  return queued;
}

/** The server's clock: every minute the rhythm, and every two seconds the scheduler. */
export function startClock(ctxFor: () => Promise<Ctx[]>, commit = ""): () => void {
  let busy = false;
  const minute = setInterval(() => {
    void (async () => { for (const ctx of await ctxFor()) await rhythm(ctx, { commit }).catch((e) => console.error("rhythm failed", e)); })();
  }, 60_000);
  const fast = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => { for (const ctx of await ctxFor()) await tick(ctx).catch((e) => console.error("scheduler failed", e)); })().finally(() => { busy = false; });
  }, 2_000);
  return () => { clearInterval(minute); clearInterval(fast); };
}
