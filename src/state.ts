import type { Db } from "./db.js";

let current: Db | null = null;
export function setDb(next: Db | null) { current = next; }
export function db(): Db {
  if (!current) throw new Error("The database is not open yet.");
  return current;
}

/**
 * What is happening right now, for the screen: which summaries and projects light up, what the chat is doing,
 * which runs are live. The page asks for it every second or so; `version` tells it whether anything changed.
 */
export interface Live {
  version: number;
  /** Summaries it opened or touched lately (id → when), for lighting up the tree. */
  lit: Record<string, number>;
  /** Projects it is working in or updated lately. */
  litProjects: Record<string, number>;
  chat: { busy: boolean; round: number; why: string; stopAsked: boolean } ;
  /** What its own work is doing now, in a sentence. */
  doing: string;
}

export const live: Live = { version: 1, lit: {}, litProjects: {}, chat: { busy: false, round: 0, why: "", stopAsked: false }, doing: "" };

const LIT_MS = 20_000;
export function bump() { live.version += 1; }
export function light(summaryIds: string[]) {
  const now = Date.now();
  for (const sid of summaryIds) live.lit[sid] = now;
  bump();
}
export function lightProject(projectId: string) {
  live.litProjects[projectId] = Date.now();
  bump();
}
export function setDoing(text: string) { if (live.doing !== text) { live.doing = text; bump(); } }
export function liveView() {
  const now = Date.now();
  for (const [k, t] of Object.entries(live.lit)) if (now - t > LIT_MS) delete live.lit[k];
  for (const [k, t] of Object.entries(live.litProjects)) if (now - t > LIT_MS) delete live.litProjects[k];
  return live;
}

/** Wakes its own work up: anything that comes in calls this. */
type Waker = () => void;
let waker: Waker = () => {};
export function onWake(fn: Waker) { waker = fn; }
export function wake() { waker(); }
