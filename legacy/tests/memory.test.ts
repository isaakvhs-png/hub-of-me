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
    // Reflection no longer rewrites a portrait: what it concludes is added to its own brick.
    const inner = (await db.query(`SELECT portrait FROM inner_state WHERE user_id = $1`, [user.id])).rows[0];
    expect(inner.portrait).toBe("");
    const { listBricks, listEntries } = await import("../src/brain/store.js");
    const me = (await listBricks(db, user.id)).find((b) => b.kind === "self")!;
    expect((await listEntries(db, user.id, { brickId: me.id })).some((e) => e.kind === "conclusion" && e.text.includes("I know very little yet"))).toBe(true);
  });
});

describe("filing before answering", () => {
  it("files his message into the web by code, then answers with the web in view", async () => {
    const { db, user, ai, mock } = await fresh();
    const blobs: string[] = [];
    scriptAgent(mock, (blob) => { blobs.push(blob); return { say: "Got it.", used: [] }; });
    const result = await runAgentTurn(db, ai, user.id, { text: "Lorenzo showed a map of the Gulf\nWhy are dwarf mangroves relevant?" });
    expect(result.reply).toBe("Got it.");
    const { listBricks, listEntries } = await import("../src/brain/store.js");
    const bricks = await listBricks(db, user.id);
    expect(bricks.some((b) => b.name.startsWith("Lorenzo showed"))).toBe(true);
    expect((await listEntries(db, user.id, { status: "open" })).some((e) => e.kind === "question")).toBe(true);
    expect(blobs[0]).toContain("THE WALL:");
    expect(blobs[0]).toContain("Lorenzo showed");
    expect(blobs[0]).toContain("YOUR AGENDA.");
    // No separate taking-in beat any more: one step, one answer.
    expect(blobs.length).toBe(1);
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
    expect(merged).toContain("You work alongside Isaak on his career");
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
        think: [{ tool: "todos", input: { action: "remember", title: "Ask about the sandbag routine", why: "He mentioned training", phrase: "sandbag" } }],
      };
      return { say: "Tell me about the sandbag." };
    });
    const result = await runAgentTurn(db, ai, user.id, { text: "I never sit still, and I train with a sandbag." });
    expect(result.traces.map((t) => t.destination).sort()).toEqual(["ledger: kept"]);
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

describe("its first moment", () => {
  it("takes stock of itself, puts its first pursuits on its agenda and what it learns about itself on its own brick", async () => {
    const { db, user, ai, mock } = await fresh();
    const blobs: string[] = [];
    let n = 0;
    scriptAgent(mock, (blob) => {
      blobs.push(blob);
      n += 1;
      if (blob.includes("TAKING STOCK.")) {
        return { taken_in: "I am new and know nothing.", think: [{ tool: "agenda_add", input: { kind: "pursuit", text: "Learn who he is before saying much", why: "My lasting job" } }] };
      }
      return { say: "Hi Isaak." };
    });
    const result = await runAgentTurn(db, ai, user.id, { cue: "GREETING DUE" });
    expect(result.reply).toBe("Hi Isaak.");
    expect(blobs[1]).toContain("WHAT YOU TOOK STOCK OF: I am new and know nothing.");
    const { listAgenda, listBricks } = await import("../src/brain/store.js");
    expect((await listAgenda(db, user.id)).map((a) => a.text)).toEqual(["Learn who he is before saying much"]);
    expect((await listBricks(db, user.id)).some((b) => b.kind === "self" && b.name === "Me")).toBe(true);
    // Its agenda is repeated at the very end of the next step, as commitments.
    expect(blobs[1].slice(blobs[1].lastIndexOf("READ THESE AGAIN"))).toContain("Learn who he is before saying much");
    // A later greeting (it already has an agenda) does not take stock again.
    blobs.length = 0;
    await runAgentTurn(db, ai, user.id, { cue: "GREETING DUE" });
    expect(blobs.some((b) => b.includes("TAKING STOCK."))).toBe(false);
    void n;
  });
});

describe("new Nature lines (6 Nov)", () => {
  it("replace the old Nature in a live soul once, as a new version, and keep the rest", async () => {
    const { db, user } = await fresh();
    const { SEED_SOUL } = await import("../src/soul-seed.js");
    const { adoptNature, changeSoul } = await import("../src/soul.js");
    const { getSoul } = await import("../src/repo.js");
    const old = SEED_SOUL.replace(/^1\. You work alongside Isaak.*$/m, "1. You are getting to know Isaak over a long time, so that you can become genuinely good for him.") + "\nA line it grew.\n";
    await changeSoul(db, user.id, { content: old, reason: "the old lines", via: "user" });
    expect(await adoptNature(db, user.id)).toBe(true);
    const now = (await getSoul(db, user.id))!.content;
    expect(now).toContain("1. You work alongside Isaak on his career");
    expect(now).not.toContain("You are getting to know Isaak");
    expect(now).toContain("A line it grew.");
    expect(await adoptNature(db, user.id)).toBe(false);
    await db.close();
  });
});
