import { EventEmitter } from "node:events";

/**
 * Live events for the single view (server-sent events). Nothing here is stored: run_steps is the record; this is the
 * wire that makes the map light up while a step is still going. No model calls are spent on visualisation.
 */
export type LiveEvent =
  | { type: "step-start"; runId: string; node: string; kind: string; label: string; at: string }
  | { type: "step"; runId: string; id: string; node: string; kind: string; label: string; ms: number; ok: boolean; model: string | null; lit?: Lit; at: string }
  | { type: "delta"; runId: string; text: string }
  | { type: "chat"; id: string; kind: string; content: string; runId: string | null; at: string }
  | { type: "run"; runId: string; status: string; trigger: string; job: string; purpose: string }
  | { type: "bench"; id: string; kind: string; title: string }
  | { type: "refs"; runId: string; refs: string[] };

/** What a step touched in the memory, so the rings can light it: ids of bricks, pages, sources, and the life document. */
export interface Lit { bricks?: string[]; pages?: string[]; sources?: string[]; life?: boolean }

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export function emit(userId: string, event: LiveEvent): void {
  emitter.emit(userId, event);
}

export function subscribe(userId: string, fn: (event: LiveEvent) => void): () => void {
  emitter.on(userId, fn);
  return () => emitter.off(userId, fn);
}
