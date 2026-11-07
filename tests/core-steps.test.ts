import { describe, expect, it } from "vitest";
import { createDb, migrate } from "../src/db.js";
import { migrateCore } from "../src/core/schema.js";
import { ensureAccount } from "../src/core/accounts.js";
import { logStep, timed, type RunCtx } from "../src/core/steps.js";
import { subscribe } from "../src/core/bus.js";
import type { Models } from "../src/core/ai.js";

const noModels: Models = { mode: "mock", modelFor: () => "none", call: async () => { throw new Error("no model in this test"); } };

describe("run_steps: one log for the live map, diagnostics and the review", () => {
  it("migrates twice, writes timed steps, and streams them live", async () => {
    const db = await createDb({ memory: true });
    await migrate(db);
    await migrateCore(db);
    await migrateCore(db);
    const user = await ensureAccount(db);
    const ctx: RunCtx = { db, userId: user.id, ai: noModels, now: () => new Date(), runId: "r1" };
    const seen: string[] = [];
    const off = subscribe(user.id, (e) => seen.push(`${e.type}:${"node" in e ? e.node : ""}`));
    await timed(ctx, "run/starter", "event", "starter", async () => 42);
    await logStep(ctx, { node: "run/pack", kind: "event", label: "pack", lit: { bricks: ["b1"] } });
    await expect(timed(ctx, "run/callA", "call", "call A", async () => { throw new Error("refused"); })).rejects.toThrow("refused");
    off();
    const rows = (await db.query(`SELECT node, ok, seq, detail FROM run_steps WHERE run_id='r1' ORDER BY seq`)).rows;
    expect(rows.map((r) => r.node)).toEqual(["run/starter", "run/pack", "run/callA"]);
    expect(rows[2].ok).toBe(false);
    expect(JSON.parse(String(rows[1].detail)).lit.bricks).toEqual(["b1"]);
    expect(seen).toContain("step-start:run/starter");
    expect(seen).toContain("step:run/pack");
    await expect(logStep(ctx, { node: "nowhere/at-all", kind: "event", label: "x" })).rejects.toThrow("not in the system map");
    await db.close();
  });
});
