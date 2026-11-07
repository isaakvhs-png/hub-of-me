import { KNOBS } from "../knobs.js";
import { emit } from "./bus.js";
import { similarTo, embedOwners } from "./embed.js";
import { iso, json, sid, truthy } from "./store.js";
import type { Ctx } from "./steps.js";

/**
 * Everything addressed to Isaak (the bench), its ongoing work (goals), and what it asks for (requests and proposals).
 * BUILD_SPEC §5.8, §5.10. Requests and proposals carry a target: "self" or one of Isaak's projects (a page of kind project).
 */

// ---------- bench ----------

export type BenchKind = "draft" | "suggestion" | "question" | "checkin" | "report" | "note" | "todo";
export interface BenchItem { id: string; kind: BenchKind; title: string; body: string; status: string; refs: Record<string, unknown>; target: string; origin: string; hisNote: string; createdAt: string; runId: string | null }

const mapBench = (r: Record<string, unknown>): BenchItem => ({
  id: String(r.id), kind: String(r.kind) as BenchKind, title: String(r.title), body: String(r.body), status: String(r.status), refs: json(r.refs, {}),
  target: String(r.target ?? "self"), origin: String(r.origin ?? "its"), hisNote: String(r.his_note ?? ""), createdAt: iso(r.created_at), runId: r.run_id == null ? null : String(r.run_id),
});

export async function putOnBench(ctx: Ctx & { runId?: string }, item: { kind: BenchKind; title: string; body: string; refs?: Record<string, unknown>; target?: string; origin?: "its" | "his" }): Promise<BenchItem> {
  const benchId = sid();
  await ctx.db.query(`INSERT INTO bench (id, user_id, kind, title, body, refs, target, run_id, origin, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [benchId, ctx.userId, item.kind, item.title.slice(0, 200), item.body, JSON.stringify(item.refs ?? {}), item.target ?? "self", ctx.runId ?? null, item.origin ?? "its", ctx.now().toISOString()]);
  emit(ctx.userId, { type: "bench", id: benchId, kind: item.kind, title: item.title });
  return (await listBench(ctx, { id: benchId }))[0];
}

export async function listBench(ctx: Ctx, opts: { id?: string; open?: boolean } = {}): Promise<BenchItem[]> {
  const r = opts.id
    ? await ctx.db.query(`SELECT * FROM bench WHERE user_id=$1 AND id=$2`, [ctx.userId, opts.id])
    : await ctx.db.query(`SELECT * FROM bench WHERE user_id=$1 AND archived_at IS NULL ${opts.open ? "AND status='open'" : ""} ORDER BY created_at DESC LIMIT 200`, [ctx.userId]);
  return r.rows.map(mapBench);
}

export async function setBenchStatus(ctx: Ctx, benchId: string, status: "open" | "done" | "dismissed" | "used", note = ""): Promise<void> {
  await ctx.db.query(`UPDATE bench SET status=$3, his_note=$4 WHERE user_id=$1 AND id=$2`, [ctx.userId, benchId, status, note]);
}

// ---------- goals ----------

export interface Goal { id: string; text: string; why: string; target: string; status: string; nextRunId: string | null; steps: { at: string; note: string }[]; origin: string; createdAt: string }
const mapGoal = (r: Record<string, unknown>): Goal => ({ id: String(r.id), text: String(r.text), why: String(r.why), target: String(r.target), status: String(r.status), nextRunId: r.next_run_id == null ? null : String(r.next_run_id), steps: json(r.steps, []), origin: String(r.origin), createdAt: iso(r.created_at) });

export async function addGoal(ctx: Ctx, g: { text: string; why: string; target?: string; origin?: "own" | "his" | "code" }): Promise<Goal> {
  const goalId = sid();
  await ctx.db.query(`INSERT INTO goals (id, user_id, text, why, target, origin, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [goalId, ctx.userId, g.text, g.why, g.target ?? "self", g.origin ?? "own", ctx.now().toISOString()]);
  return (await listGoals(ctx)).find((x) => x.id === goalId)!;
}

export async function listGoals(ctx: Ctx, open = false): Promise<Goal[]> {
  const r = await ctx.db.query(`SELECT * FROM goals WHERE user_id=$1 AND archived_at IS NULL ${open ? "AND status='open'" : ""} ORDER BY created_at`, [ctx.userId]);
  return r.rows.map(mapGoal);
}

export async function stepGoal(ctx: Ctx, goalId: string, note: string, nextRunId?: string | null): Promise<void> {
  const goal = (await listGoals(ctx)).find((g) => g.id === goalId);
  if (!goal) throw new Error(`No goal ${goalId}.`);
  const steps = [...goal.steps, { at: ctx.now().toISOString(), note }];
  await ctx.db.query(`UPDATE goals SET steps=$3, next_run_id=COALESCE($4, next_run_id) WHERE user_id=$1 AND id=$2`, [ctx.userId, goalId, JSON.stringify(steps), nextRunId ?? null]);
}

export async function closeGoal(ctx: Ctx, goalId: string, why: string): Promise<void> {
  await stepGoal(ctx, goalId, `closed: ${why}`);
  await ctx.db.query(`UPDATE goals SET status='done' WHERE user_id=$1 AND id=$2`, [ctx.userId, goalId]);
}

// ---------- requests ----------

export interface Request {
  id: string; target: string; title: string; kind: string; problem: string; proposal: string; spec: Record<string, unknown>; prediction: string;
  dependsOn: string[]; unblocks: string[]; status: string; evidenceRuns: string[]; evidenceCount: number; protected: boolean;
  hisDecision: string | null; hisWhy: string; builtIn: string | null; liveAt: string | null; mergedInto: string | null; createdAt: string; updatedAt: string;
}
const mapRequest = (r: Record<string, unknown>): Request => ({
  id: String(r.id), target: String(r.target), title: String(r.title), kind: String(r.kind), problem: String(r.problem), proposal: String(r.proposal), spec: json(r.spec, {}),
  prediction: String(r.prediction), dependsOn: json(r.depends_on, []), unblocks: json(r.unblocks, []), status: String(r.status), evidenceRuns: json(r.evidence_runs, []),
  evidenceCount: Number(r.evidence_count), protected: truthy(r.protected), hisDecision: r.his_decision == null ? null : String(r.his_decision), hisWhy: String(r.his_why ?? ""),
  builtIn: r.built_in == null ? null : String(r.built_in), liveAt: r.live_at == null ? null : iso(r.live_at), mergedInto: r.merged_into == null ? null : String(r.merged_into), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

/** Paths and parts only Isaak may change: anything touching them is protected, set by code (§5.10, §5.11). */
const PROTECTED = [/\btests?\//i, /boundar/i, /\bnature\b/i, /src\/ai\/plan\.ts/i, /sign[- ]?in|oauth|auth token|password/i, /protected path/i];
export function isProtected(text: string): boolean {
  return PROTECTED.some((p) => p.test(text));
}

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

export async function listRequests(ctx: Ctx, opts: { open?: boolean } = {}): Promise<Request[]> {
  const r = await ctx.db.query(`SELECT * FROM requests WHERE user_id=$1 AND archived_at IS NULL ${opts.open ? "AND status IN ('open','ready')" : ""} ORDER BY evidence_count DESC, created_at`, [ctx.userId]);
  return r.rows.map(mapRequest);
}

export async function getRequest(ctx: Ctx, requestId: string): Promise<Request | null> {
  const r = await ctx.db.query(`SELECT * FROM requests WHERE user_id=$1 AND id=$2`, [ctx.userId, requestId]);
  return r.rows[0] ? mapRequest(r.rows[0]) : null;
}

/**
 * A gap: open a request, or add evidence to the one it already is. Matching is by the same title or, when the meaning
 * is very close, by similar meaning; the review merges what this misses. Ready after N runs of evidence, or when it blocks.
 */
export async function addRequestOrEvidence(ctx: Ctx & { runId?: string }, gap: { title: string; kind?: string; problem?: string; proposal?: string; prediction?: string; target?: string; unblocks?: string[]; dependsOn?: string[] }): Promise<{ request: Request; isNew: boolean }> {
  const open = await listRequests(ctx, { open: true });
  let match = open.find((r) => norm(r.title) === norm(gap.title));
  if (!match && open.length) {
    const { hits } = await similarTo(ctx, `${gap.title}. ${gap.problem ?? ""}`, { kinds: ["request"], limit: 1 });
    if (hits[0] && hits[0].score > (hits[0].model.startsWith("local") ? 0.8 : 0.9)) match = open.find((r) => r.id === hits[0].id);
  }
  const runId = ctx.runId ?? null;
  if (match) {
    const runs = runId && !match.evidenceRuns.includes(runId) ? [...match.evidenceRuns, runId] : match.evidenceRuns;
    const ready = runs.length >= KNOBS.requestReadyAfterRuns || match.unblocks.length > 0 || (gap.unblocks?.length ?? 0) > 0;
    await ctx.db.query(`UPDATE requests SET evidence_runs=$3, evidence_count=$4, status=$5, unblocks=$6, updated_at=$7 WHERE id=$2 AND user_id=$1`,
      [ctx.userId, match.id, JSON.stringify(runs), runs.length, ready && match.status === "open" ? "ready" : match.status, JSON.stringify([...new Set([...match.unblocks, ...(gap.unblocks ?? [])])]), ctx.now().toISOString()]);
    return { request: (await getRequest(ctx, match.id))!, isNew: false };
  }
  const requestId = sid();
  const text = `${gap.title} ${gap.problem ?? ""} ${gap.proposal ?? ""}`;
  const runs = runId ? [runId] : [];
  const blocking = (gap.unblocks?.length ?? 0) > 0;
  await ctx.db.query(
    `INSERT INTO requests (id, user_id, target, title, kind, problem, proposal, prediction, depends_on, unblocks, status, evidence_runs, evidence_count, protected, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
    [requestId, ctx.userId, gap.target ?? "self", gap.title.slice(0, 200), gap.kind ?? "hand", gap.problem ?? "", gap.proposal ?? "", gap.prediction ?? "",
      JSON.stringify(gap.dependsOn ?? []), JSON.stringify(gap.unblocks ?? []), blocking || runs.length >= KNOBS.requestReadyAfterRuns ? "ready" : "open",
      JSON.stringify(runs), runs.length, isProtected(text), ctx.now().toISOString()],
  );
  await embedOwners(ctx, [{ kind: "request", id: requestId, text: `${gap.title}. ${gap.problem ?? ""}` }]);
  return { request: (await getRequest(ctx, requestId))!, isNew: true };
}

export async function updateRequest(ctx: Ctx, requestId: string, patch: Partial<{ status: string; mergedInto: string; hisDecision: string; hisWhy: string; prediction: string; spec: Record<string, unknown>; dependsOn: string[]; unblocks: string[]; builtIn: string; liveAt: string; proposal: string }>): Promise<void> {
  const cur = await getRequest(ctx, requestId);
  if (!cur) return;
  await ctx.db.query(
    `UPDATE requests SET status=$3, merged_into=$4, his_decision=$5, his_why=$6, prediction=$7, spec=$8, depends_on=$9, unblocks=$10, built_in=$11, live_at=$12, proposal=$13, updated_at=$14 WHERE user_id=$1 AND id=$2`,
    [ctx.userId, requestId, patch.status ?? cur.status, patch.mergedInto ?? cur.mergedInto, patch.hisDecision ?? cur.hisDecision, patch.hisWhy ?? cur.hisWhy, patch.prediction ?? cur.prediction,
      JSON.stringify(patch.spec ?? cur.spec), JSON.stringify(patch.dependsOn ?? cur.dependsOn), JSON.stringify(patch.unblocks ?? cur.unblocks), patch.builtIn ?? cur.builtIn, patch.liveAt ?? cur.liveAt, patch.proposal ?? cur.proposal, ctx.now().toISOString()],
  );
}

// ---------- proposals ----------

export interface Proposal { id: string; target: string; title: string; why: string; requestIds: string[]; status: string; hisDecision: string | null; hisWhy: string; spec: string; prediction: string; cost: string; createdAt: string }
const mapProposal = (r: Record<string, unknown>): Proposal => ({ id: String(r.id), target: String(r.target), title: String(r.title), why: String(r.why), requestIds: json(r.request_ids, []), status: String(r.status), hisDecision: r.his_decision == null ? null : String(r.his_decision), hisWhy: String(r.his_why ?? ""), spec: String(r.spec ?? ""), prediction: String(r.prediction ?? ""), cost: String(r.cost ?? ""), createdAt: iso(r.created_at) });

export async function addProposal(ctx: Ctx, p: { title: string; why: string; requestIds: string[]; target?: string; spec?: string; prediction?: string; cost?: string }): Promise<Proposal> {
  const proposalId = sid();
  await ctx.db.query(`INSERT INTO proposals (id, user_id, target, title, why, request_ids, spec, prediction, cost, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [proposalId, ctx.userId, p.target ?? "self", p.title.slice(0, 200), p.why, JSON.stringify(p.requestIds), p.spec ?? "", p.prediction ?? "", p.cost ?? "", ctx.now().toISOString()]);
  for (const r of p.requestIds) await updateRequest(ctx, r, { status: "proposed" });
  return (await listProposals(ctx)).find((x) => x.id === proposalId)!;
}

export async function listProposals(ctx: Ctx): Promise<Proposal[]> {
  const r = await ctx.db.query(`SELECT * FROM proposals WHERE user_id=$1 AND archived_at IS NULL ORDER BY (status='ready') DESC, created_at DESC`, [ctx.userId]);
  return r.rows.map(mapProposal);
}

/** Isaak decides: yes / not now / no, because… / revise / discuss. Declined ones stay visible with his reason. */
export async function decideProposal(ctx: Ctx, proposalId: string, decision: "yes" | "not_now" | "no" | "revise" | "discuss" | "live", why: string): Promise<void> {
  const status = { yes: "accepted", not_now: "parked", no: "declined", revise: "revising", discuss: "discussing", live: "live" }[decision];
  await ctx.db.query(`UPDATE proposals SET status=$3, his_decision=$4, his_why=$5 WHERE user_id=$1 AND id=$2`, [ctx.userId, proposalId, status, decision, why]);
  const p = (await listProposals(ctx)).find((x) => x.id === proposalId);
  for (const r of p?.requestIds ?? []) {
    await updateRequest(ctx, r, decision === "live"
      ? { status: "live", liveAt: ctx.now().toISOString(), builtIn: why || "live" }
      : { status: decision === "no" ? "declined" : decision === "yes" ? "accepted" : decision === "not_now" ? "parked" : "proposed", hisDecision: decision, hisWhy: why });
  }
}
