import { describe, expect, it } from "vitest";
import { runAgentTurn } from "../src/agent/turn.js";
import { memoryView } from "../src/agent/memory.js";
import { listEvents } from "../src/repo.js";
import { fresh } from "./helpers.js";

function scriptAgent(mock: { complete: (req: any) => Promise<any> }, answer: (blob: string) => object) {
  const original = mock.complete.bind(mock);
  mock.complete = async (req: any) => {
    if (!String(req.system).includes("TASK: agent")) return original(req);
    const result = await original(req);
    const blob = `${req.system}\n${(req.messages ?? []).map((m: any) => m.content).join("\n")}`;
    return { ...result, text: JSON.stringify(answer(blob)) };
  };
}

describe("memory", () => {
  it("keeps every note on the map and, while it fits, open in full", async () => {
    const { db, user, ai, mock } = await fresh();
    let first = true;
    scriptAgent(mock, () => {
      if (!first) return { say: "Noted." };
      first = false;
      return { think: [{ tool: "notebook_write", input: { title: "Bachelor at VU", summary: "Biology bachelor, thornback ray thesis", body: "Started at 20; thesis on thornback ray maturity.", folder: "About him/Studies", kind: "background" } }] };
    });
    await runAgentTurn(db, ai, user.id, { text: "I studied biology at the VU." });
    const view = await memoryView(db, user.id);
    expect(view.text).toContain("About him/Studies · background · Bachelor at VU — Biology bachelor, thornback ray thesis");
    expect(view.text).toContain("all 1 notes are open in full");
    expect(view.text).toContain("Started at 20; thesis on thornback ray maturity.");
  });

  it("sees the earlier conversation, not only the new message", async () => {
    const { db, user, ai, mock } = await fresh();
    let lastBlob = "";
    scriptAgent(mock, (blob) => { lastBlob = blob; return { say: "Ok." }; });
    const first = await runAgentTurn(db, ai, user.id, { text: "My dog is called Bram." });
    await runAgentTurn(db, ai, user.id, { text: "What was his name again?", conversationId: first.conversationId });
    expect(lastBlob).toContain("My dog is called Bram.");
  });

  it("can put things in his calendar and reflect in its own words", async () => {
    const { db, user, ai, mock } = await fresh();
    let step = 0;
    scriptAgent(mock, () => {
      step += 1;
      if (step === 1) return { think: [
        { tool: "calendar", input: { action: "add", title: "Call with Shinichi", starts_at: "2026-11-05T10:00:00+01:00", ends_at: "2026-11-05T10:30:00+01:00", why: "He mentioned it." } },
        { tool: "reflect", input: { about: "What I know about him so far" } },
      ] };
      return { say: "Done." };
    });
    await runAgentTurn(db, ai, user.id, { text: "I have a call with Shinichi on Thursday at 10." });
    const events = await listEvents(db, user.id, "2026-11-01T00:00:00.000Z", "2026-11-30T00:00:00.000Z");
    expect(events.map((e: any) => e.title)).toContain("Call with Shinichi");
    const claims = await db.query(`SELECT statement FROM claims WHERE user_id = $1`, [user.id]);
    expect(claims.rows.map((r: any) => r.statement)).toContain("He wants to understand before he commits");
  });
});
