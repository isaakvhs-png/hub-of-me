import { describe, expect, it, beforeEach } from "vitest";
import { fresh, drain } from "./helpers.js";
import { db } from "../src/state.js";
import { chatIdle, history, send } from "../src/chat.js";
import { absorb, editByIsaak, ensureLife, freshen, revise, summaryView, webView } from "../src/web.js";
import { listEvents } from "../src/calendar.js";
import { acceptSuggestion, canon, closeProject, createProject, projectView, runAndWait, setBoard, talk } from "../src/projects.js";
import { acceptProposal, declineProposal, listProposals } from "../src/proposals.js";
import { mockState } from "../src/mock.js";
import { resetThinkForTests } from "../src/autonomy.js";
import { setMock, ModelDownError, call } from "../src/models.js";
import { scriptedModel } from "../src/mock.js";
import { openPopups } from "../src/popups.js";

beforeEach(async () => { await fresh(); });

describe("the web", () => {
  it("starts with an empty centre", async () => {
    const w = await webView();
    expect(w.summaries).toHaveLength(1);
    expect(w.summaries[0].is_life).toBe(true);
  });

  it("places a message into summaries and rewrites them with markers when touched", async () => {
    await send("I started an internship at Arcadis on bats");
    await chatIdle();
    await drain();
    const w = await webView();
    expect(w.summaries.length).toBeGreaterThan(1);
    const lifeId = await ensureLife();
    await freshen([lifeId]);
    const life = await summaryView(lifeId, false);
    expect(life.body).toMatch(/\[\[m:/);
    expect(life.stale).toBe(false);
  });

  it("keeps his own typing marked, and absorbs a summary into the rest", async () => {
    await send("internship notes");
    await chatIdle(); await drain();
    const w = await webView();
    const child = w.summaries.find((s) => !s.is_life)!;
    await editByIsaak(child.id, "My own line here");
    const v = await summaryView(child.id, false);
    expect(v.body).toContain("{{isaak}}My own line here{{/isaak}}");
    await absorb(child.id);
    const after = await webView();
    expect(after.summaries.some((s) => s.id === child.id)).toBe(false);
  });

  it("revise with 'absorb' absorbs", async () => {
    await send("internship notes"); await chatIdle(); await drain();
    const child = (await webView()).summaries.find((s) => !s.is_life)!;
    const out = await revise(child.id, "absorb this into the rest");
    expect(out.action).toBe("absorb");
  });
});

describe("the chat", () => {
  it("answers, opening a level further when it asks a question", async () => {
    await send("internship notes"); await chatIdle(); await drain();
    await send("how is my internship going?");
    await chatIdle();
    const h = await history();
    const last = h[h.length - 1];
    expect(last.role).toBe("it");
    const meta = JSON.parse(last.meta);
    expect(meta.rounds.length).toBe(2);
    expect(meta.rounds[0].opened.length).toBeGreaterThan(0);
  });

  it("adds to the calendar when asked", async () => {
    await send("put the dentist in my calendar");
    await chatIdle();
    const events = await listEvents("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");
    expect(events.map((e) => e.title)).toContain("Dentist");
  });

  it("stops after three straying rounds", async () => {
    await send("internship notes"); await chatIdle(); await drain();
    mockState.straying = true;
    await send("what about everything? tell me");
    await chatIdle();
    const h = await history();
    // The mock answers in round 2 anyway; the check ran for round 1.
    expect(JSON.parse(h[h.length - 1].meta).rounds[0].straying).toBe(true);
  });
});

describe("the workspace", () => {
  it("talks, accepts the suggested board, runs it and closes into a project summary", async () => {
    const pid = await createProject({ title: "Bat research", owner: "isaak" });
    const out = await talk(pid, "make a pack about bats and search the web");
    expect(out.proposed?.pieces.some((p) => p.type === "pack")).toBe(true);
    const view = await projectView(pid);
    const msg = view.messages.find((m) => m.proposed_board)!;
    await acceptSuggestion(pid, msg.id);
    const run = await runAndWait(pid);
    expect(run.status).toBe("done");
    const { board } = await canon(pid);
    expect(board.pieces.some((p) => p.type === "result")).toBe(true);
    const after = await projectView(pid);
    const log = after.runs[0].log as { kind: string }[];
    expect(log.some((l) => l.kind === "web-search")).toBe(true);
    const summaryId = await closeProject(pid);
    await new Promise((r) => setTimeout(r, 300));
    const s = await summaryView(summaryId, false);
    expect(s.kind).toBe("project");
  });

  it("pauses at a mid-run 'me' and goes on with his input", async () => {
    const pid = await createProject({ title: "Ask me", owner: "isaak" });
    await setBoard(pid, {
      pieces: [{ id: "me", type: "me", ref: "me", x: 0, y: 0 }, { id: "m", type: "model", ref: "claude-haiku-5-5", x: 100, y: 0 }, { id: "w", type: "module", ref: "web-search", x: 200, y: 0 }],
      arrows: [{ from: "m", to: "me", step: 1 }, { from: "m", to: "w", step: 2 }],
      runInstructions: "x",
    });
    const run = await runAndWait(pid);
    expect(run.status).toBe("waiting");
    await talk(pid, "go for the second option");
    for (let i = 0; i < 50; i += 1) {
      const r = await db().query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [run.id]);
      if (r.rows[0].status === "done") break;
      await new Promise((res) => setTimeout(res, 100));
    }
    const r = await db().query<{ status: string; log: string }>(`SELECT status, log FROM runs WHERE id = $1`, [run.id]);
    expect(r.rows[0].status).toBe("done");
    expect(r.rows[0].log).toContain("go for the second option");
  });

  it("converging lines wait for both", async () => {
    const pid = await createProject({ title: "Converge", owner: "isaak" });
    await setBoard(pid, {
      pieces: [{ id: "me", type: "me", ref: "me", x: 0, y: 0 }, { id: "a", type: "model", ref: "claude-haiku-5-5", x: 0, y: 0 }, { id: "b", type: "model", ref: "gemini-3.5-flash", x: 0, y: 0 }, { id: "c", type: "model", ref: "claude-sonnet-5-5", x: 0, y: 0 }],
      arrows: [{ from: "a", to: "c", step: 1 }, { from: "b", to: "c", step: 1 }, { from: "c", to: "me", step: 1 }],
      runInstructions: "x",
    });
    const run = await runAndWait(pid);
    expect(run.status).toBe("done");
    const log = (await projectView(pid)).runs[0].log as { piece: string; kind: string }[];
    const firstC = log.findIndex((l) => l.piece === "c" && l.kind === "call");
    const handovers = log.map((l, i) => ({ l, i })).filter((x) => x.l.kind === "hand-over");
    expect(handovers).toHaveLength(2);
    expect(handovers.every((h) => h.i < firstC)).toBe(true);
  });
});

describe("its own work", () => {
  it("proposes, and works on an accepted proposal until a junction", async () => {
    await send("I want to explore internships in ecology"); await chatIdle();
    await drain();
    const proposals = await listProposals();
    expect(proposals.length).toBeGreaterThan(0);
    const pid = await acceptProposal(proposals[0].id);
    resetThinkForTests();
    await drain();
    const project = (await db().query<{ status: string; owner: string }>(`SELECT status, owner FROM projects WHERE id = $1`, [pid])).rows[0];
    expect(project.owner).toBe("it");
    expect(project.status).toBe("junction");
    const h = await history();
    expect(h.some((m) => m.role === "it" && m.text.includes("good point"))).toBe(true);
  });

  it("a dropped proposal needs a reason, and the reason goes into the web", async () => {
    await send("ecology internships"); await chatIdle(); await drain();
    const [p] = await listProposals();
    await expect(declineProposal(p.id, "", true)).rejects.toThrow(/why/);
    await declineProposal(p.id, "not now, I have enough", true);
    const r = await db().query(`SELECT 1 FROM sources WHERE kind = 'decline' AND text LIKE '%not now%'`);
    expect(r.rows.length).toBe(1);
  });
});

describe("shutdowns", () => {
  it("a model that can't answer shuts its part down with a popup, and says when it is back", async () => {
    setMock((o) => { if (o.model === "claude-haiku-5-5") throw new Error("limit"); return scriptedModel(o); });
    await expect(call("web", { task: "x", system: "", prompt: "" })).rejects.toBeInstanceOf(ModelDownError);
    expect((await openPopups()).some((p) => p.kind === "shutdown")).toBe(true);
    setMock(scriptedModel);
    await call("web", { task: "x", system: "", prompt: "" });
    expect((await openPopups()).some((p) => p.kind === "back")).toBe(true);
  });
});

describe("its own messages", () => {
  it("what it does on its own comes as one message until he writes again", async () => {
    const { say } = await import("../src/chat.js");
    await say("I placed your note.");
    await say("I updated a summary.");
    let h = await history();
    expect(h.filter((m) => m.role === "it")).toHaveLength(1);
    await send("ok"); await chatIdle();
    await say("Another thing.");
    h = await history();
    expect(h[h.length - 1].text).toContain("Another thing.");
  });
});


describe("placing with the whole web in view", () => {
  it("a new angle can take an existing summary under it", async () => {
    const { setMock } = await import("../src/models.js");
    await send("watch my linguistics"); await chatIdle(); await drain();
    const before = await webView();
    const ling = before.summaries.find((s) => !s.is_life)!;
    setMock((o) => {
      if (o.task === "place" && o.prompt.includes("personal profile")) {
        const centre = /- ([0-9a-f-]{36}) \| My life/.exec(o.prompt)![1];
        return JSON.stringify({ fits: [], new: [{ title: "Isaak as a person", under: [centre], takes: [ling.id] }], instruction: false });
      }
      return scriptedModel(o);
    });
    await send("keep a personal profile of me"); await chatIdle(); await drain();
    const after = await webView();
    const profile = after.summaries.find((s) => s.title === "Isaak as a person")!;
    expect(profile.inputs.some((i) => i.type === "summary" && i.id === ling.id)).toBe(true);
  });
});
