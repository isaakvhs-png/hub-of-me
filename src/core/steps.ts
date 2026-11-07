import type { Db } from "../db.js";
import { id } from "../ids.js";
import { mapPaths } from "../self/map.js";
import { emit, type Lit } from "./bus.js";
import type { Models } from "./ai.js";

/** What every part of the core is handed: the database, whose memory it is, and the models. */
export interface Ctx {
  db: Db;
  userId: string;
  ai: Models;
  /** Code's clock; tests move it. */
  now: () => Date;
}

/** A context inside one run: every step it takes is written to run_steps under this id. */
export interface RunCtx extends Ctx {
  runId: string;
}

export type StepKind = "call" | "act" | "event";

const KNOWN = new Set(mapPaths());
/** Every run_steps.node is a path in the system map (src/self/map.ts). Unknown paths fail loudly in tests. */
export function assertNode(node: string): void {
  if (KNOWN.has(node)) return;
  const message = `run_steps node "${node}" is not in the system map (src/self/map.ts)`;
  if (process.env.VITEST || process.env.NODE_ENV === "test") throw new Error(message);
  console.error(message);
}

const seqs = new Map<string, number>();
function nextSeq(runId: string): number {
  const n = (seqs.get(runId) ?? 0) + 1;
  seqs.set(runId, n);
  if (seqs.size > 500) seqs.delete(seqs.keys().next().value as string);
  return n;
}

export interface StepRecord {
  node: string;
  kind: StepKind;
  label: string;
  model?: string | null;
  ms?: number;
  charsIn?: number;
  charsOut?: number;
  ok?: boolean;
  detail?: Record<string, unknown>;
  lit?: Lit;
}

/** Write one step (already finished) to the record and to the live view. */
export async function logStep(ctx: RunCtx, step: StepRecord): Promise<string> {
  assertNode(step.node);
  const stepId = id();
  const at = ctx.now().toISOString();
  const detail = { ...(step.detail ?? {}), ...(step.lit ? { lit: step.lit } : {}) };
  await ctx.db.query(
    `INSERT INTO run_steps (id, user_id, run_id, node, kind, label, model, ms, chars_in, chars_out, ok, detail, seq, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [stepId, ctx.userId, ctx.runId, step.node, step.kind, step.label.slice(0, 500), step.model ?? null, Math.round(step.ms ?? 0),
      step.charsIn ?? 0, step.charsOut ?? 0, step.ok ?? true, JSON.stringify(detail), nextSeq(ctx.runId), at],
  );
  emit(ctx.userId, { type: "step", runId: ctx.runId, id: stepId, node: step.node, kind: step.kind, label: step.label, ms: Math.round(step.ms ?? 0), ok: step.ok ?? true, model: step.model ?? null, lit: step.lit, at });
  return stepId;
}

/**
 * Time a piece of work as one step. The view gets a start event at once (so the box glows while a long call runs) and
 * the finished step when it ends. A failure is recorded with ok=false and rethrown.
 */
export async function timed<T>(
  ctx: RunCtx,
  node: string,
  kind: StepKind,
  label: string,
  fn: () => Promise<T>,
  info?: (result: T) => Partial<StepRecord>,
): Promise<T> {
  assertNode(node);
  const started = Date.now();
  emit(ctx.userId, { type: "step-start", runId: ctx.runId, node, kind, label, at: ctx.now().toISOString() });
  try {
    const result = await fn();
    const extra = info ? info(result) : {};
    await logStep(ctx, { node, kind, label, ms: Date.now() - started, ...extra, ok: extra.ok ?? true });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logStep(ctx, { node, kind, label: `${label} (failed)`, ms: Date.now() - started, ok: false, detail: { error: message.slice(0, 1000) } });
    throw error;
  }
}
