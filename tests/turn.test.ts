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
    const blob = `${req.system}\n${(req.messages ?? []).map((m: any) => m.content).join("\n")}`;
    return { ...result, text: JSON.stringify(answer(blob)) };
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

describe("its own choices", () => {
  it("files a note in the folder and kind it chooses", async () => {
    const { db, user, ai, mock } = await fresh();
    let first = true;
    scriptAgent(mock, () => {
      if (first) {
        first = false;
        return { think: { what: "Keep it", why: "Thesis idea", tool: "notebook_write", input: { title: "LiDAR and deer", body: "Link browsing to snowfall.", folder: "Kyoto/Thesis ideas", kind: "research idea" } } };
      }
      return { say: "Kept it under Kyoto." };
    });
    const result = await runAgentTurn(db, ai, user.id, { text: "LiDAR could show where deer browse after snow." });
    expect(result.notes[0]?.type).toBe("research idea");
    const folders = await db.query(`SELECT name FROM folders WHERE user_id = $1`, [user.id]);
    expect(folders.rows.map((r: any) => r.name)).toEqual(expect.arrayContaining(["Kyoto", "Thesis ideas"]));
  });

  it("wakes when it chose to, and not before", async () => {
    const { db, user, ai, mock } = await fresh();
    const { wakeIfDue } = await import("../src/agent/turn.js");
    let woke = 0;
    scriptAgent(mock, (system) => {
      if (system.includes("WAKE:")) { woke += 1; return { say: "" }; }
      if (system.includes("You will wake at")) return { say: "I'll look into it later." };
      return { think: { what: "Plan", why: "Later", tool: "wake_me", input: { in_minutes: 30, why: "Check the Kyoto deadline" } } };
    });
    await runAgentTurn(db, ai, user.id, { text: "The Kyoto deadline is somewhere in December." });
    const row = (await db.query(`SELECT next_wake_at, wake_why FROM inner_state WHERE user_id = $1`, [user.id])).rows[0];
    expect(row.wake_why).toBe("Check the Kyoto deadline");
    expect(await wakeIfDue(db, ai, user.id, new Date())).toBe(false);
    expect(await wakeIfDue(db, ai, user.id, new Date(Date.now() + 31 * 60_000))).toBe(true);
    expect(woke).toBe(1);
    const after = (await db.query(`SELECT next_wake_at FROM inner_state WHERE user_id = $1`, [user.id])).rows[0];
    expect(after.next_wake_at).toBeNull();
  });
});

describe("a message left without a reply", () => {
  it("gets answered once, without saving his message twice", async () => {
    const { db, user, ai, mock } = await fresh();
    const { answerUnanswered } = await import("../src/agent/turn.js");
    const { addMessage } = await import("../src/repo.js");
    scriptAgent(mock, () => ({ say: "Sorry for the wait. Here is my read." }));
    const conv = await createConversation(db, user.id, "Dump");
    await addMessage(db, conv, "user", "My long opening dump.");
    const later = new Date(Date.now() + 2 * 60_000);
    expect(await answerUnanswered(db, ai, user.id, later)).toBe(true);
    const msgs = await listMessages(db, conv);
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(await answerUnanswered(db, ai, user.id, later)).toBe(false);
  });
});

describe("steps", () => {
  it("runs several tools in one step and treats a blank tool as none", async () => {
    const { db, user, ai, mock } = await fresh();
    let calls = 0;
    scriptAgent(mock, (system) => {
      calls += 1;
      if (system.includes("Saved note")) return { say: "Got both.", think: { what: "", why: "", tool: "", input: {} } };
      return {
        think: [
          { what: "Keep A", why: "a", tool: "notebook_write", input: { title: "Born 2001 in Amsterdam", body: "Born 12 July 2001.", folder: "About him", kind: "fact" } },
          { what: "Keep B", why: "b", tool: "notebook_write", input: { title: "Lives by principles", body: "Has principles he will share later.", folder: "About him", kind: "value" } },
        ],
      };
    });
    const result = await runAgentTurn(db, ai, user.id, { text: "I was born in 2001 and I live by principles." });
    expect(result.notes.length).toBe(2);
    expect(result.reply).toBe("Got both.");
    expect(calls).toBe(2);
  });

  it("switches to the model it asks for, and starts there next time", async () => {
    const { db, user, ai, mock } = await fresh();
    const seen: string[] = [];
    const original = mock.complete.bind(mock);
    mock.complete = async (req: any) => {
      if (String(req.system).includes("TASK: agent")) seen.push(String(req.messages?.[0]?.content ?? "").match(/thinking with (\S+) right now/)?.[1] ?? "?");
      return original(req);
    };
    scriptAgent(mock, (system) =>
      system.includes("thinking with mock-strong") ? { say: "Thought it through." } : { next_model: "mock-strong", think: { what: "Read", why: "Heavy", tool: "notebook_read", input: {} } },
    );
    await runAgentTurn(db, ai, user.id, { text: "A long story about my life." });
    expect(seen).toEqual(["mock-cheap", "mock-strong"]);
    const row = (await db.query(`SELECT start_model FROM inner_state WHERE user_id = $1`, [user.id])).rows[0];
    expect(row.start_model).toBe("mock-strong");
  });
});

describe("formatting slips", () => {
  it("reads a wrapped answer, a list sent as text, and an object where a sentence was expected", async () => {
    const { db, user, ai, mock } = await fresh();
    let n = 0;
    scriptAgent(mock, () => {
      n += 1;
      if (n === 1) return { think: JSON.stringify([{ tool: "notebook_write", input: { title: "Vision", body: "Consultancy", folder: "Isaak/Vision", kind: "profile" } }]), taken_in: { what: "His introduction", missing: "family, friends" } };
      return { object: { say: "Here is my read." } };
    });
    const result = await runAgentTurn(db, ai, user.id, { text: "Long introduction about my life." });
    expect(result.reply).toBe("Here is my read.");
    expect(result.notes.map((note) => note.title)).toEqual(["Vision"]);
    expect(n).toBe(2);
  });
});

describe("a pinned model", () => {
  it("runs every step on the model he pinned, and its own switch waits", async () => {
    const { db, user, ai, mock } = await fresh();
    await db.query(`UPDATE settings SET pinned_model = 'mock-strong' WHERE user_id = $1`, [user.id]);
    const seen: string[] = [];
    const original = mock.complete.bind(mock);
    mock.complete = async (req: any) => {
      if (String(req.system).includes("TASK: agent")) seen.push(String(req.messages?.[0]?.content ?? "").match(/thinking with (\S+) right now/)?.[1] ?? "?");
      return original(req);
    };
    scriptAgent(mock, (blob) => (blob.includes("TAKING IN.") ? { next_model: "mock-cheap", taken_in: "ok" } : { say: "Done." }));
    await runAgentTurn(db, ai, user.id, { text: "A long story." });
    expect(seen.every((m) => m === "mock-strong")).toBe(true);
    expect(seen.length).toBe(2);
  });
});
