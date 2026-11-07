import { createDb, type Db } from "../../src/db.js";
import { bootCore, send, type Upload } from "../../src/core/index.js";
import { MockModels } from "../../src/core/mock.js";
import { drain, resetQueueForTests } from "../../src/core/queue.js";
import { rhythm } from "../../src/core/rhythm.js";
import type { Ctx } from "../../src/core/steps.js";

/**
 * The bench harness: a fresh in-memory database, the mock model, and a clock the case moves.
 * The bench tests plumbing: that every part does its job and records it. Judgment needs the real model (BUILD_SPEC §11a).
 */
export interface Bench {
  db: Db;
  ctx: Ctx;
  mock: MockModels;
  clock: { t: number };
  say: (text: string, files?: Upload[]) => Promise<string>;
  advance: (minutes: number) => Promise<void>;
  steps: (runId?: string) => Promise<{ node: string; label: string; ok: boolean; run_id: string }[]>;
  rows: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
}

export async function bench(start = "2026-11-09T09:00:00Z"): Promise<Bench> {
  resetQueueForTests();
  const db = await createDb({ memory: true });
  const clock = { t: new Date(start).getTime() };
  // Each reading moves the clock by a millisecond, so records keep their order the way a real clock would.
  const now = () => new Date((clock.t += 1));
  const { userIds } = await bootCore(db, { now });
  const mock = new MockModels();
  const ctx: Ctx = { db, userId: userIds[0], ai: mock, now };
  const b: Bench = {
    db, ctx, mock, clock,
    async say(text, files) {
      const { run } = await send(ctx, { text, files, clientMsgId: `m${clock.t}` });
      await drain(ctx);
      clock.t += 1000;
      return run!.id;
    },
    async advance(minutes) {
      for (let i = 0; i < minutes; i += 30) {
        clock.t += Math.min(30, minutes - i) * 60_000;
        await rhythm(ctx);
        await drain(ctx);
      }
    },
    async steps(runId) {
      const r = await db.query<{ node: string; label: string; ok: boolean; run_id: string }>(`SELECT node, label, ok, run_id FROM run_steps ${runId ? "WHERE run_id=$1" : ""} ORDER BY at, seq`, runId ? [runId] : []);
      return r.rows;
    },
    async rows(sql, params) { return (await db.query(sql, params)).rows as never; },
    close: () => db.close(),
  };
  return b;
}
