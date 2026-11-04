import { describe, expect, it } from "vitest";
import { runAgentTurn, workingNow } from "../src/agent/turn.js";
import { listActions } from "../src/repo.js";
import { fresh } from "./helpers.js";

describe("what it is doing, and what failed", () => {
  it("shows a turn while it runs, even one nobody on the page started, and clears it after", async () => {
    const { db, user, ai, mock } = await fresh();
    const seen: (ReturnType<typeof workingNow>)[] = [];
    const original = mock.complete.bind(mock);
    mock.complete = async (req: any) => {
      if (String(req.system).includes("TASK: agent")) {
        seen.push(workingNow(user.id));
        const result = await original(req);
        return { ...result, text: JSON.stringify({ say: "Hi." }) };
      }
      return original(req);
    };
    await runAgentTurn(db, ai, user.id, { cue: "WAKE: test" });
    expect(seen[0]?.phase).toBeTruthy();
    expect(workingNow(user.id)).toBeNull();
  });

  it("keeps a failed model call in the action log", async () => {
    const { db, user, ai, mock } = await fresh();
    mock.complete = async () => { throw new Error("Your credit balance is too low"); };
    await expect(runAgentTurn(db, ai, user.id, { text: "Hello" })).rejects.toThrow();
    const actions = await listActions(db, user.id, 50);
    expect(actions.some((a) => a.what === "model call failed" && /credit balance/.test(String(a.why)))).toBe(true);
  });

  it("tells it that independent tool uses can share a step", async () => {
    const { db, user, ai, mock } = await fresh();
    let system = "";
    const original = mock.complete.bind(mock);
    mock.complete = async (req: any) => {
      if (String(req.system).includes("TASK: agent")) system = String(req.system);
      const result = await original(req);
      return String(req.system).includes("TASK: agent") ? { ...result, text: JSON.stringify({ say: "Ok." }) } : result;
    };
    await runAgentTurn(db, ai, user.id, { cue: "WAKE: test" });
    expect(system).toContain("can go in one step");
  });
});
