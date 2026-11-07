import { planAvailable, planLimited, planStatus } from "../ai/plan.js";
import { iso } from "./store.js";
import type { Ctx } from "./steps.js";
import { backlog } from "./upkeep.js";

/**
 * The code checks (BUILD_SPEC §10, docs/FAILURE_MODES.md "routine"): plain facts from the records, no model.
 * Each check says ok or not, and why.
 */
export interface Check { name: string; ok: boolean; detail: string }

export async function healthChecks(ctx: Ctx): Promise<Check[]> {
  const now = ctx.now().getTime();
  const checks: Check[] = [];
  const day = new Date(now - 86_400_000).toISOString();
  const beats = (await ctx.db.query<{ at: unknown }>(`SELECT at FROM heartbeat WHERE user_id=$1 AND at >= $2 ORDER BY at`, [ctx.userId, day])).rows.map((r) => new Date(iso(r.at)).getTime());
  const gaps: string[] = [];
  for (let i = 1; i < beats.length; i += 1) if (beats[i] - beats[i - 1] > 3 * 60_000) gaps.push(`${new Date(beats[i - 1]).toISOString().slice(11, 16)}–${new Date(beats[i]).toISOString().slice(11, 16)} UTC`);
  const lastBeat = beats.length ? beats[beats.length - 1] : null;
  checks.push({ name: "heartbeat", ok: gaps.length === 0 && lastBeat != null && now - lastBeat < 5 * 60_000, detail: lastBeat ? `last beat ${Math.round((now - lastBeat) / 1000)} s ago; asleep in the last 24 h: ${gaps.join(", ") || "never"}` : "no heartbeat yet" });
  const stuck = (await ctx.db.query(`SELECT id, status, job, started_at, created_at FROM runs WHERE user_id=$1 AND ((status='running' AND started_at < $2) OR (status='paused' AND created_at < $3) OR (status='queued' AND COALESCE(due_at, created_at) < $3))`, [ctx.userId, new Date(now - 30 * 60_000).toISOString(), new Date(now - 86_400_000).toISOString()])).rows;
  checks.push({ name: "runs not stuck", ok: stuck.length === 0, detail: stuck.length ? stuck.map((r) => `${r.id} ${r.job} ${r.status}`).join(", ") : "none stuck" });
  const failedRuns = (await ctx.db.query(`SELECT id, job, error FROM runs WHERE user_id=$1 AND status='failed' AND created_at >= $2`, [ctx.userId, day])).rows;
  checks.push({ name: "runs that failed (24 h)", ok: failedRuns.length === 0, detail: failedRuns.map((r) => `${r.id} ${r.job}: ${String(r.error).slice(0, 120)}`).join("; ") || "none" });
  const cut = (await ctx.db.query(`SELECT title, orig_size, stored_size FROM sources WHERE user_id=$1 AND archived_at IS NULL AND orig_size > stored_size`, [ctx.userId])).rows;
  checks.push({ name: "files kept whole", ok: cut.length === 0, detail: cut.map((s) => `"${s.title}" ${s.stored_size} of ${s.orig_size}`).join("; ") || "nothing cut off" });
  const failedParts = (await ctx.db.query(`SELECT title, failed_parts FROM sources WHERE user_id=$1 AND archived_at IS NULL AND failed_parts <> '[]'`, [ctx.userId])).rows;
  checks.push({ name: "filing parts that failed", ok: failedParts.length === 0, detail: failedParts.map((s) => `"${s.title}": ${s.failed_parts}`).join("; ") || "none waiting for a retry" });
  const dups = (await ctx.db.query<{ client_msg_id: string; n: string }>(`SELECT client_msg_id, count(*) AS n FROM stream WHERE user_id=$1 AND client_msg_id IS NOT NULL GROUP BY client_msg_id HAVING count(*) > 1`, [ctx.userId])).rows;
  checks.push({ name: "messages stored once", ok: dups.length === 0, detail: dups.length ? `${dups.length} duplicate client ids` : "no duplicates" });
  const unanswered = (await ctx.db.query(`SELECT s.id FROM stream s WHERE s.user_id=$1 AND s.kind='his' AND s.at < $2 AND NOT EXISTS (SELECT 1 FROM stream t WHERE t.user_id=s.user_id AND t.kind='its' AND t.at > s.at)`, [ctx.userId, new Date(now - 10 * 60_000).toISOString()])).rows;
  checks.push({ name: "every message answered", ok: unanswered.length === 0, detail: unanswered.length ? `${unanswered.length} message(s) older than 10 minutes without a reply after them` : "yes" });
  const b = await backlog(ctx);
  checks.push({ name: "stale backlog", ok: b < 30, detail: `${b} page(s) waiting` });
  const status = planStatus();
  checks.push({ name: "plan allowance", ok: !planLimited(), detail: planAvailable() ? (status ? `${status.type} ${status.status}, utilisation ${status.utilization ?? "?"}, resets ${status.resetsAt ?? "?"}` : "no status from the plan yet") : "the plan route is not set up (CLAUDE_CODE_OAUTH_TOKEN)" });
  const created = process.env.CLAUDE_TOKEN_CREATED?.trim();
  if (created) {
    const age = (now - new Date(created).getTime()) / 86_400_000;
    checks.push({ name: "sign-in token age", ok: age < 335, detail: `the Claude token is ${Math.round(age)} days old; it expires after a year (a reminder a month ahead)` });
  } else checks.push({ name: "sign-in token age", ok: true, detail: "unknown: set CLAUDE_TOKEN_CREATED (YYYY-MM-DD) on Render to get a reminder a month before it expires" });
  checks.push({ name: "running commit", ok: true, detail: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? "unknown" });
  return checks;
}
