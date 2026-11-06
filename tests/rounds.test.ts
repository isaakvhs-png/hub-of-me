import { describe, expect, it } from "vitest";
import { fresh } from "./helpers.js";
import { runAgentTurn } from "../src/agent/turn.js";
import { listRuns } from "../src/mind/rounds.js";
import { listAgenda, listBricks, listEntries } from "../src/brain/store.js";

async function rounds() {
  const env = await fresh();
  await env.db.query(`UPDATE settings SET mind_loop = 'rounds' WHERE user_id = $1`, [env.user.id]);
  return env;
}

describe("thinking in rounds", () => {
  it("thinks in at least two rounds, decides, answers, and keeps the whole run", async () => {
    const { db, user, ai } = await rounds();
    const result = await runAgentTurn(db, ai, user.id, { text: "I start at Wetlands International on Monday." });
    expect(result.reply).toBe("I thought it through in rounds.");
    const [run] = await listRuns(db, user.id);
    expect(run.rounds.length).toBeGreaterThanOrEqual(2);
    expect(run.rounds[0].stance).toBe("draft");
    expect(run.rounds[1].stance).toBe("challenge");
    expect(run.say).toBe(result.reply);
    expect(run.endedAt).not.toBeNull();
    await db.close();
  });

  it("does what a hand fits, then looks again with the result before answering", async () => {
    const { db, user, ai } = await rounds();
    const result = await runAgentTurn(db, ai, user.id, { text: "Can you look up mangrove carbon in Kenya" });
    const [run] = await listRuns(db, user.id);
    expect(run.acts[0]).toMatchObject({ fit: "full", hand: "search" });
    expect(run.acts[0].result).toContain("MOCK SEARCH");
    expect(result.reply).toBe("I looked it up and thought it through.");
    await db.close();
  });

  it("turns reaching a person into a suggestion for him", async () => {
    const { db, user, ai } = await rounds();
    await runAgentTurn(db, ai, user.id, { text: "Please tell Shinichi I am still interested" });
    const first = (await listAgenda(db, user.id, { open: true })).filter((a) => a.kind === "suggestion");
    expect(first).toHaveLength(1);
    await db.close();
  });

  it("designs a gap for what it can't do yet, and adds evidence to the same gap next time", async () => {
    const { db, user, ai } = await rounds();
    await runAgentTurn(db, ai, user.id, { text: "What is in my inbox?" });
    await runAgentTurn(db, ai, user.id, { text: "Check my inbox again please" });
    const gaps = (await listBricks(db, user.id)).filter((b) => b.kind === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].name).toBe("Needs: read his email");
    const entries = await listEntries(db, user.id, { brickId: gaps[0].id });
    expect(entries.filter((e) => e.kind === "evidence")).toHaveLength(2);
    expect(entries.some((e) => e.kind === "design")).toBe(true);
    await db.close();
  });

  it("files what it concluded as its own thinking, and keeps predictions on its own brick", async () => {
    const { db, user, ai } = await rounds();
    await runAgentTurn(db, ai, user.id, { text: "Can you predict whether Shinichi replies" });
    const me = (await listBricks(db, user.id)).find((b) => b.kind === "self")!;
    const entries = await listEntries(db, user.id, { brickId: me.id });
    expect(entries.some((e) => e.kind === "prediction" && e.status === "open")).toBe(true);
    const own = await db.query(`SELECT 1 FROM brain_stream WHERE user_id = $1 AND kind = 'own'`, [user.id]);
    expect(own.rows.length).toBe(1);
    await db.close();
  });

  it("tries another model when one refuses a draft, instead of failing the turn", async () => {
    const { db, user, ai, mock } = await rounds();
    mock.refuseDrafts = 1;
    const result = await runAgentTurn(db, ai, user.id, { text: "How did my first week go?" });
    expect(result.reply).toBe("I thought it through in rounds.");
    const refused = await db.query(`SELECT why FROM action_log WHERE user_id = $1 AND what = 'model refused, trying another'`, [user.id]);
    expect(refused.rows).toHaveLength(1);
    await db.close();
  });
});
