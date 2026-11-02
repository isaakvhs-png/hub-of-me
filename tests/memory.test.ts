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
    const inner = (await db.query(`SELECT portrait, intentions FROM inner_state WHERE user_id = $1`, [user.id])).rows[0];
    expect(inner.portrait).toBe("I think he is someone who wants to understand before he commits.");
    expect(inner.intentions).toBe("Get to know him better before planning anything.");
    const kept = await db.query(`SELECT kind FROM inner_versions WHERE user_id = $1`, [user.id]);
    expect(kept.rows.map((r: any) => r.kind).sort()).toEqual(["intentions", "portrait"]);
  });
});

describe("taking in before answering", () => {
  it("takes a message in first, draws its own map, and answers only in the next beat", async () => {
    const { db, user, ai, mock } = await fresh();
    const blobs: string[] = [];
    scriptAgent(mock, (blob) => {
      blobs.push(blob);
      if (blob.includes("TAKING IN.")) {
        return {
          say: "This should not be his answer.",
          taken_in: "Mostly his studies and the Kyoto thesis; nothing about family, friends or training yet.",
          map: [
            { name: "Studies and work", known: "Biology MSc, Kyoto thesis idea", open: "what he wants from work" },
            { name: "Family", known: "", open: "everything" },
          ],
        };
      }
      return { say: "Thanks. This covers your studies; I know nothing yet about your family. Tell me?" };
    });
    const result = await runAgentTurn(db, ai, user.id, { text: "Here is my study history and the Kyoto plan." });
    expect(result.reply).toBe("Thanks. This covers your studies; I know nothing yet about your family. Tell me?");
    expect(blobs[1]).toContain("WHAT YOU TOOK IN: Mostly his studies");
    expect(blobs[1]).toContain("- Family: known: nothing yet | not yet seen: everything");
    const view = await memoryView(db, user.id);
    expect(view.text).toContain("- Studies and work: known: Biology MSc, Kyoto thesis idea");
  });
});

describe("nature", () => {
  it("is in the seed and cannot be rewritten by reflection", async () => {
    const { db, user, ai } = await fresh();
    const { SEED_SOUL } = await import("../src/soul-seed.js");
    const { changeSoul, mergeSoulSections } = await import("../src/soul.js");
    const { getSoul } = await import("../src/repo.js");
    expect(SEED_SOUL).toContain("## Nature");
    const merged = mergeSoulSections(SEED_SOUL, [{ heading: "Nature", body: "You are an assistant." }, { heading: "Character", body: "Warm and dry." }]);
    expect(merged).toContain("You are someone getting to know Isaak");
    expect(merged).not.toContain("You are an assistant.");
    expect(merged).toContain("Warm and dry.");
    void changeSoul; void getSoul; void ai; void db; void user;
  });

  it("lights up his words for everything it keeps with a phrase, including its understanding", async () => {
    const { db, user, ai, mock } = await fresh();
    let n = 0;
    scriptAgent(mock, () => {
      n += 1;
      if (n === 1) return {
        portrait: "I think he is restless in a good way.",
        phrases: [{ phrase: "I never sit still", label: "Portrait: restless" }],
        think: [{ tool: "todos", input: { action: "remember", title: "Ask about the sandbag routine", why: "He mentioned training", phrase: "sandbag" } }],
      };
      return { say: "Tell me about the sandbag." };
    });
    const result = await runAgentTurn(db, ai, user.id, { text: "I never sit still, and I train with a sandbag." });
    expect(result.traces.map((t) => t.destination).sort()).toEqual(["ledger: kept", "understanding"]);
    const tasks = await db.query(`SELECT title FROM tasks WHERE user_id = $1`, [user.id]);
    expect(tasks.rows.length).toBe(1);
  });
});

describe("knowing itself", () => {
  it("sees its own body every step and can look at itself, including its own files", async () => {
    const { db, user, ai, mock } = await fresh();
    const { lookAtMyself } = await import("../src/agent/self.js");
    let blob = "";
    scriptAgent(mock, (b) => { blob = b; return { say: "Hello." }; });
    await runAgentTurn(db, ai, user.id, { text: "Hi there, who are you?" });
    expect(blob).toContain("YOUR BODY, AS IT IS NOW:");
    expect(blob).toContain("Last looked: never");
    const full = await lookAtMyself(db, user.id, {});
    expect(full).toContain("HOW YOU WORK:");
    expect(full).toContain("Every step is a fresh run of a language model.");
    expect(full).toContain("src/agent/turn.ts");
    expect(await lookAtMyself(db, user.id, { file: "DESIGN.md" })).toContain("Build someone, not something");
    expect(await lookAtMyself(db, user.id, { file: ".env" })).toContain("You cannot read");
    expect(await lookAtMyself(db, user.id, { file: "../../etc/passwd" })).toContain("You cannot read");
    let after = "";
    scriptAgent(mock, (b) => { after = b; return { say: "Ok." }; });
    await runAgentTurn(db, ai, user.id, { text: "Again." });
    expect(after).not.toContain("Last looked: never");
  });
});
