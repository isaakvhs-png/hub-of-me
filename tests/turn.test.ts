import { describe, expect, it } from "vitest";
import { runAgentTurn } from "../src/agent/turn.js";
import { createConversation, listDebates, listMessages } from "../src/repo.js";
import { fresh } from "./helpers.js";

/** Replace the mock's agent answers with a script, so a test can play a model that behaves badly. */
function scriptAgent(mock: { complete: (req: any) => Promise<any> }, answer: (system: string) => object) {
  const original = mock.complete.bind(mock);
  mock.complete = async (req: any) => {
    if (!String(req.system).includes("TASK: agent")) return original(req);
    const result = await original(req);
    return { ...result, text: JSON.stringify(answer(String(req.system))) };
  };
}

describe("agent turn", () => {
  it("posts what it said even when it also used a tool in the same step", async () => {
    const { db, user, ai, mock } = await fresh();
    scriptAgent(mock, () => ({ say: "Hi Isaak, tell me more.", think: { what: "Look", why: "Context", tool: "notebook_read", input: {} } }));
    const result = await runAgentTurn(db, ai, user.id, { text: "Hello, this is my first message." });
    expect(result.reply).toBe("Hi Isaak, tell me more.");
    const messages = await listMessages(db, result.conversationId);
    expect(messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
  });

  it("answers at the end even when it keeps choosing tools and never speaks", async () => {
    const { db, user, ai, mock } = await fresh();
    scriptAgent(mock, (system) =>
      system.includes("Answer him now") ? { say: "Here is what I have so far." } : { think: { what: "Read again", why: "More", tool: "notebook_read", input: {} } },
    );
    const result = await runAgentTurn(db, ai, user.id, { text: "Hello there, first contact." });
    expect(result.reply).toBe("Here is what I have so far.");
  });

  it("starts a live conversation instead of writing into an archived one", async () => {
    const { db, user, ai } = await fresh();
    const old = await createConversation(db, user.id, "Old");
    await db.query(`UPDATE conversations SET archived_at = now() WHERE id = $1`, [old]);
    const result = await runAgentTurn(db, ai, user.id, { text: "A new thought after the fresh start.", conversationId: old });
    expect(result.conversationId).not.toBe(old);
    expect((await listMessages(db, old)).length).toBe(0);
  });

  it("leaves archived debates out of the live list but keeps them as history", async () => {
    const { db, user } = await fresh();
    await db.query(`INSERT INTO debates (id, user_id, question, status, archived_at) VALUES ('d-old', $1, 'Old question', 'concluded', now())`, [user.id]);
    expect((await listDebates(db, user.id)).some((d: any) => d.id === "d-old")).toBe(false);
    expect((await listDebates(db, user.id, true)).some((d: any) => d.id === "d-old")).toBe(true);
  });
});
