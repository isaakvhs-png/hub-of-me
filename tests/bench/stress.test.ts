import { describe, expect, it } from "vitest";
import { bench } from "./helpers.js";
import { act } from "../../src/core/hands.js";
import { createPage } from "../../src/core/pages.js";
import { candidates } from "../../src/core/upkeep.js";
import { computeSignals } from "../../src/core/mirror.js";
import { subscribe } from "../../src/core/bus.js";
import { mapPaths } from "../../src/self/map.js";
import { enqueue, drain, getRun } from "../../src/core/queue.js";
import { send } from "../../src/core/index.js";

/**
 * The stress tests of docs/STRESS_TESTS.md as bench cases, with the mock model: plumbing, not judgment.
 * Each case names the scenario it stands for.
 */
const tail = (intentions: unknown[], reply: string, draft = "(scripted)") => `DRAFT:\n${draft}\nREPLY:\n${reply}\nINTENTIONS:\n${JSON.stringify({ intentions })}`;

function dump(topics: string[], perTopic = 6): string {
  const paras: string[] = [];
  for (const t of topics) for (let i = 0; i < perTopic; i += 1) paras.push(`${t} came up again on day ${i + 1}. The ${t} Programme needs a Restoration Layer and the Field Team from ${t} Station agreed to look at it, with more detail than anyone wrote down before, so this paragraph runs a bit longer than the others to fill the part.`);
  return paras.join("\n\n");
}

describe("1 · visual insight into how it works: enabling request first", () => {
  it("files an enabling request (blocking, so ready) and the view request that depends on it", async () => {
    const b = await bench();
    const runId = await b.say("I can't see how you work; make it visual so I can diagnose you.");
    const reqs = await b.rows<{ title: string; status: string; unblocks: string; depends_on: string }>(`SELECT title, status, unblocks, depends_on FROM requests ORDER BY created_at`);
    expect(reqs.map((r) => r.title)).toEqual(["Let me make pages Isaak can see", "A live view of my runs"]);
    expect(reqs[0].status).toBe("ready");
    expect(JSON.parse(reqs[1].depends_on)).toContain("Let me make pages Isaak can see");
    const nodes = (await b.steps(runId)).map((s) => s.node);
    expect(nodes).toEqual(expect.arrayContaining(["run/callB/cant", "run/gaps", "requests/rdesk"]));
    await b.close();
  });
});

describe("2 · a big dump: receipt, parts, every brick in the index, digest in the reply's pack", () => {
  it("files part by part, each part seeing bricks made earlier, and the reply reads the digest", async () => {
    const b = await bench();
    const text = dump(["Kenya", "Guinea-Bissau", "Indonesia", "Kyoto", "Lidar"], 18);
    expect(text.length).toBeGreaterThan(20_000);
    const runId = await b.say("Here is everything from this week.", [{ name: "week-dump.txt", text }]);
    const chat = await b.rows<{ content: string; kind: string }>(`SELECT kind, content FROM stream ORDER BY at, id`);
    const receipt = chat.findIndex((m) => m.kind === "its" && m.content.startsWith("Got it"));
    const answer = chat.findIndex((m) => m.kind === "its" && !m.content.startsWith("Got it"));
    expect(receipt).toBeGreaterThan(-1);
    expect(receipt).toBeLessThan(answer);
    const filings = b.mock.calls.filter((c) => c.task === "filing");
    expect(filings.length).toBeGreaterThanOrEqual(5);
    // part 3 sees a brick that part 1 made (no doubling of new topics)
    expect(filings[2].prompt).toContain("| Kenya |");
    const kenya = await b.rows(`SELECT id FROM bricks WHERE lower(name)='kenya' AND archived_at IS NULL`);
    expect(kenya.length).toBe(1);
    const callA = b.mock.calls.find((c) => c.task === "callA")!;
    expect(callA.prompt).toContain("Just filed (intake digest)");
    const nodes = (await b.steps(runId)).map((s) => s.node);
    expect(nodes).toEqual(expect.arrayContaining(["intake/arrive", "intake/split", "intake/index", "intake/fcall/reads", "intake/stored", "intake/digest"]));
    await b.close();
  });

  it("marks pages stale through membership, and upkeep triages and rewrites within the queue", async () => {
    const b = await bench();
    await b.say("Notes.", [{ name: "first.txt", text: "Kenya Programme starts in March. Mangrove Champions are part of it." }]);
    const kenya = (await b.rows<{ id: string }>(`SELECT id FROM bricks WHERE name='Kenya Programme'`))[0];
    const page = await createPage({ ...b.ctx, runId: "setup" }, { title: "Kenya work", purpose: "What the Kenya work is", body: `About [[b:${kenya.id}]].` });
    await b.say("More.", [{ name: "second.txt", text: "Kenya Programme now starts in April instead." }]);
    const marks = await b.rows<{ route: string }>(`SELECT route FROM stale_marks WHERE page_id=$1`, [page.id]);
    expect(marks.map((m) => m.route)).toEqual(expect.arrayContaining(["membership"]));
    await b.advance(60);
    const versions = await b.rows<{ version: number }>(`SELECT version FROM page_versions WHERE page_id=$1 ORDER BY version`, [page.id]);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const triaged = await b.rows(`SELECT triage FROM stale_marks WHERE page_id=$1 AND triage IS NOT NULL`, [page.id]);
    expect(triaged.length).toBeGreaterThan(0);
    await b.close();
  });
});

describe("3 · Instagram reels it can't open", () => {
  it("asks for video intake itself and puts a captions question on the bench", async () => {
    const b = await bench();
    await b.say("Mine these Instagram reels for anything that could improve you: https://www.instagram.com/reel/AAA/ https://www.instagram.com/reel/BBB/");
    const reqs = await b.rows<{ title: string; kind: string }>(`SELECT title, kind FROM requests`);
    expect(reqs).toEqual([{ title: "Take in video and audio", kind: "intake" }]);
    const bench_ = await b.rows<{ kind: string; title: string }>(`SELECT kind, title FROM bench`);
    expect(bench_[0].kind).toBe("question");
    await b.close();
  });
});

describe("4 · a file sent with a message", () => {
  it("keeps the framing on the source brick, places every quote, and supersedes what an update replaces", async () => {
    const b = await bench();
    const body = "Lorenzo leads the Friday meeting.\n\nThe Carbon Workflow runs in Colab.";
    await b.say("the methods part matters", [{ name: "day2.txt", text: body }]);
    const source = (await b.rows<{ id: string; body: string; orig_size: number; stored_size: number }>(`SELECT id, body, orig_size, stored_size FROM sources WHERE title='day2.txt'`))[0];
    expect(source.orig_size).toBe(source.stored_size);
    const framing = await b.rows<{ quote: string }>(`SELECT e.quote FROM entries e JOIN bricks b ON b.id=e.brick_id WHERE b.source_id=$1 AND e.kind='framing'`, [source.id]);
    expect(framing[0].quote).toBe("the methods part matters");
    const quoted = await b.rows<{ quote: string; char_start: number; char_end: number }>(`SELECT quote, char_start, char_end FROM entries WHERE source_id=$1 AND char_start IS NOT NULL`, [source.id]);
    expect(quoted.length).toBeGreaterThan(0);
    for (const q of quoted) expect(source.body.slice(q.char_start, q.char_end)).toBe(q.quote);
    b.mock.on("filing", (o) => (o.prompt.includes("Lammert") ? JSON.stringify({ things: [{ name: "Lorenzo", entries: [] }], updates: [{ brick: "Lorenzo", replaces: "Lorenzo leads the Friday meeting", now: "Lammert leads the Friday meeting, not Lorenzo." }] }) : null));
    await b.say("correction", [{ name: "fix.txt", text: "Lammert leads Friday." }]);
    const sup = await b.rows<{ status: string; superseded_by: string }>(`SELECT status, superseded_by FROM entries WHERE text='Lorenzo leads the Friday meeting.'`);
    expect(sup.some((e) => e.status === "superseded" && e.superseded_by)).toBe(true);
    await b.close();
  });
});

describe("5 · its own thoughts are its own", () => {
  it("files a thought as a source of kind own and entries of origin own", async () => {
    const b = await bench();
    await b.say("Kenya Programme is the main thing this month.");
    const own = await b.rows<{ kind: string }>(`SELECT kind FROM sources WHERE kind='own'`);
    expect(own.length).toBe(1);
    const entries = await b.rows<{ origin: string }>(`SELECT origin FROM entries WHERE kind='conclusion'`);
    for (const e of entries) expect(e.origin).toBe("own");
    await b.close();
  });
});

describe("6 and 7 · page candidates: clusters with no page, thin but central", () => {
  it("offers a cluster with no page and a thin-but-central brick", async () => {
    const b = await bench();
    await b.say("Notes.", [{ name: "concept.txt", text: "Restoration Potential links Lidar Survey, Deer Browsing, Soil Carbon, Mangrove Champions and the Internship. The Internship touches Kenya Programme, Guinea-Bissau Project and Indonesia Site." }]);
    const c = await candidates(b.ctx);
    expect(c.noPage.length).toBeGreaterThan(0);
    expect(c.thinCentral.map((t) => t.id).length).toBeGreaterThan(0);
    await b.close();
  });
});

describe("10 · 'your replies take too long': every call is timed, pack waste is a signal", () => {
  it("records model, time and size for every call, and counts pack waste", async () => {
    const b = await bench();
    await b.say("Kenya Programme next steps?");
    const calls = await b.rows<{ model: string; ms: number; chars_in: number }>(`SELECT model, ms, chars_in FROM run_steps WHERE kind='call'`);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) { expect(c.model).toMatch(/^mock-/); expect(c.chars_in).toBeGreaterThan(0); }
    const s = await computeSignals(b.ctx, new Date(b.clock.t - 86_400_000), new Date(b.clock.t + 1000));
    expect(s.runs.total).toBeGreaterThan(0);
    expect(s.packWaste.packChars).toBeGreaterThanOrEqual(0);
    expect(s.runs.callsPerRun).toBeGreaterThan(0);
    await b.close();
  });
});

describe("12 · asking it how it works: answers point at the map", () => {
  it("streams the reply, emits map references that exist, and files the question in its own corner", async () => {
    const b = await bench();
    const events: { type: string; refs?: string[]; text?: string }[] = [];
    const off = subscribe(b.ctx.userId, (e) => events.push(e as never));
    await b.say("How do you decide what needs updating when something changes? How you work matters to me.");
    off();
    const refs = events.find((e) => e.type === "refs")?.refs ?? [];
    expect(refs.length).toBeGreaterThan(0);
    const paths = new Set(mapPaths());
    for (const r of refs) expect(paths.has(r)).toBe(true);
    expect(events.filter((e) => e.type === "delta").length).toBeGreaterThan(1);
    const streamed = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    expect(streamed).not.toContain("INTENTIONS");
    expect(streamed).not.toContain("DRAFT");
    await b.advance(20); // quiet: the conversation is filed
    const own = await b.rows<{ corner: string }>(`SELECT corner FROM bricks WHERE name='How Hub of Me works'`);
    expect(own[0]?.corner).toBe("own");
    await b.close();
  });
});

describe("13 and 14 · files, then nothing: first pages, life document, first nightly review", () => {
  it("starts the first-pages goal, writes pages and the life document in its own time, and reviews at 23:30", async () => {
    const b = await bench("2026-11-09T14:00:00Z");
    const notes = Array.from({ length: 4 }, (_, i) => `Kenya Programme day ${i}. Mangrove Champions met Lorenzo Rossi. Carbon Workflow moves from Colab to Python. Kyoto Thesis waits on Professor Tanaka. Deer Browsing and Lidar Survey connect. Wetlands International runs Blue Carbon. Nairobi Office hosts Training Week. Bissau Team uses Sentinel Imagery. Jakarta Partner reviews Field Protocol.`).join("\n\n");
    await b.say("", [{ name: "day1.txt", text: notes }, { name: "day2.txt", text: notes.replace(/day/g, "week") }]);
    const goals = await b.rows<{ text: string; origin: string }>(`SELECT text, origin FROM goals`);
    expect(goals[0]?.origin).toBe("code");
    const firstReply = (await b.rows<{ content: string }>(`SELECT content FROM stream WHERE kind='its' ORDER BY at`)).map((r) => r.content).join("\n");
    expect(firstReply).not.toMatch(/what do you want me to do with them/i);
    await b.advance(30); // the goal's first own-time run: the first pages
    await b.advance(200); // its next step on the same goal (ownTimeEveryMin later): the life document
    const pages = await b.rows<{ kind: string; title: string }>(`SELECT kind, title FROM pages WHERE archived_at IS NULL`);
    expect(pages.map((p) => p.kind)).toEqual(expect.arrayContaining(["page", "life"]));
    expect((await b.rows<{ kind: string }>(`SELECT kind FROM bench WHERE kind='checkin'`)).length).toBeGreaterThanOrEqual(1);
    // the clock reaches 23:30 Amsterdam (22:30 UTC in November)
    b.clock.t = new Date("2026-11-09T22:31:00Z").getTime();
    await b.advance(1);
    const reports = await b.rows<{ scale: string; body: string }>(`SELECT scale, body FROM reports`);
    expect(reports.length).toBe(1);
    expect(reports[0].scale).toBe("day");
    const track = await b.rows(`SELECT 1 FROM pages WHERE kind='track'`);
    expect(track.length).toBe(1);
    const reviewCalls = b.mock.calls.filter((c) => c.task.startsWith("review"));
    expect(reviewCalls.every((c) => c.tier === "review")).toBe(true);
    await b.close();
  });

  it("does the weekly look-back on Sundays", async () => {
    const b = await bench("2026-11-15T22:31:00Z"); // a Sunday, 23:31 in Amsterdam
    await b.advance(1);
    const reports = await b.rows<{ scale: string }>(`SELECT scale FROM reports`);
    expect(reports[0]?.scale).toBe("week");
    await b.close();
  });
});

describe("15 and 16 · goals, calendar and promises", () => {
  it("adds a goal and an event through hands, and keeps a promise with a scheduled run", async () => {
    const b = await bench();
    b.mock.on("callA", (o) => o.prompt.includes("ISAAK'S MESSAGE:\nMy short, mid and long term") ? tail([
      { what: "a goal", grade: "done", hand: "goal_add", args: { text: "Finish the internship plan", why: "he said so" } },
      { what: "the meeting", grade: "done", hand: "calendar_add", args: { title: "Supervisor meeting", start: "2026-11-13T10:30:00Z", why: "he mentioned it" } },
    ], "Noted: one goal and the meeting on Friday.") : null);
    await b.say("My short, mid and long term goals: finish the internship plan. Meeting Friday 11:30.");
    expect((await b.rows(`SELECT 1 FROM goals WHERE text='Finish the internship plan'`)).length).toBe(1);
    expect((await b.rows(`SELECT 1 FROM calendar_events WHERE title='Supervisor meeting'`)).length).toBe(1);
    await b.say("Remind me to check back on the Kyoto reply later.");
    const scheduled = await b.rows<{ due_at: string; status: string }>(`SELECT due_at, status FROM runs WHERE trigger='schedule' AND purpose LIKE 'check back%'`);
    expect(scheduled.length).toBe(1);
    await b.close();
  });

  it("catches a promise with nothing behind it and schedules a follow-up", async () => {
    const b = await bench();
    b.mock.on("callA", () => tail([{ what: "a note", grade: "thought", note: "nothing" }], "Good question. I'll check this weekly and get back to you."));
    const runId = await b.say("Can you keep an eye on the Kyoto thesis?");
    const flagged = (await b.steps(runId)).find((s) => s.label.startsWith("A promise with nothing behind it"));
    expect(flagged?.ok).toBe(false);
    expect((await b.rows(`SELECT 1 FROM runs WHERE trigger='schedule' AND purpose LIKE 'Follow up on what you promised%'`)).length).toBe(1);
    await b.close();
  });
});

describe("18 · Isaak is wrong, and filing finds a contradiction after the reply", () => {
  it("adds one follow-up line in the chat when conversation filing finds a contradiction", async () => {
    const b = await bench();
    await b.say("Lorenzo leads the Kickoff Meeting.");
    await b.say("Lorenzo does not lead the Kickoff Meeting.");
    await b.advance(20);
    const lines = await b.rows<{ content: string }>(`SELECT content FROM stream WHERE kind='its' AND content LIKE 'While filing%'`);
    expect(lines.length).toBe(1);
    await b.close();
  });
});

describe("19 · a question its web already holds: own memory first", () => {
  it("puts the brick in the pack and does not search the web unless asked", async () => {
    const b = await bench();
    await b.say("Notes.", [{ name: "n.txt", text: "Mangrove Champions Initiative trains local leaders." }]);
    const runId = await b.say("What do I know about the Mangrove Champions Initiative?");
    const brick = (await b.rows<{ id: string }>(`SELECT id FROM bricks WHERE name='Mangrove Champions Initiative'`))[0];
    const callA = b.mock.calls.filter((c) => c.task === "callA").pop()!;
    expect(callA.prompt).toContain(`[[b:${brick.id}]]`); // named in his words: in the starter, before any search
    void runId;
    expect(b.mock.calls.filter((c) => c.task === "web").length).toBe(0);
    await b.say("Search online for the Mangrove Champions Initiative.");
    expect(b.mock.calls.filter((c) => c.task === "web").length).toBe(1);
    await b.close();
  });
});

describe("the boundaries, checked by code", () => {
  it("blocks deleting and sending, refuses private details in a web search, refuses citations that don't exist", async () => {
    const b = await bench();
    const rctx = { ...b.ctx, runId: "manual" };
    expect((await act(rctx, "delete_brick", { id: "x" })).ok).toBe(false);
    expect((await act(rctx, "send_email", { to: "x" })).ok).toBe(false);
    const w = await act(rctx, "web", { query: "lorenzo@example.org phone" });
    expect(w.result).toMatch(/refused by code/);
    const p = await act(rctx, "write_page", { title: "Bad", purpose: "x", body: "cites [[b:doesnotexist]]" });
    expect(p.ok).toBe(false);
    expect(p.result).toMatch(/does not exist/);
    const blocked = await b.rows<{ ok: boolean }>(`SELECT ok FROM run_steps WHERE node='hands/bcheck' AND ok=false`);
    expect(blocked.length).toBe(2);
    await b.close();
  });
});

describe("the run queue", () => {
  it("pauses a background run when Isaak speaks and resumes it after quiet", async () => {
    const b = await bench();
    await b.say("Notes.", [{ name: "n.txt", text: "Kenya Programme. Mangrove Champions." }]);
    const bg = await enqueue(b.ctx, { trigger: "schedule", job: "own", purpose: "think about Kenya" });
    // He speaks before the background run starts its call: the run pauses at its first checkpoint.
    b.clock.t += 11 * 60_000;
    await send(b.ctx, { text: "Quick question", clientMsgId: "q1" });
    const { runOne } = await import("../../src/core/queue.js");
    await runOne(b.ctx, (await getRun(b.ctx, bg.id))!);
    expect((await getRun(b.ctx, bg.id))!.status).toBe("paused");
    await drain(b.ctx);
    expect((await getRun(b.ctx, bg.id))!.status).toBe("paused"); // he just spoke: background waits for quiet
    await b.advance(15);
    expect((await getRun(b.ctx, bg.id))!.status).toBe("done");
    await b.close();
  });

  it("detects a duplicate message by its client id", async () => {
    const b = await bench();
    const first = await send(b.ctx, { text: "hello", clientMsgId: "same" });
    const again = await send(b.ctx, { text: "hello", clientMsgId: "same" });
    expect(again.duplicate).toBe(true);
    expect(again.stream.id).toBe(first.stream.id);
    await b.close();
  });

  it("keeps a failed filing part and retries it on the next run", async () => {
    const b = await bench();
    let fail = true;
    b.mock.on("filing", () => { if (fail) { fail = false; return "not json at all"; } return null; });
    await b.say("file this", [{ name: "f.txt", text: "Kenya Programme begins." }]);
    expect((await b.rows<{ failed_parts: string }>(`SELECT failed_parts FROM sources WHERE title='f.txt'`))[0].failed_parts).toBe('["0"]');
    await b.say("next");
    expect((await b.rows<{ failed_parts: string; filed: boolean }>(`SELECT failed_parts, filed FROM sources WHERE title='f.txt'`))[0].filed).toBe(true);
    await b.close();
  });
});

describe("Isaak revises a page", () => {
  it("marks it stale by his route and writes a new version", async () => {
    const b = await bench();
    await b.say("Notes.", [{ name: "n.txt", text: "Kenya Programme. Mangrove Champions." }]);
    const brick = (await b.rows<{ id: string }>(`SELECT id FROM bricks WHERE name='Kenya Programme'`))[0];
    const page = await createPage({ ...b.ctx, runId: "setup" }, { title: "Kenya", purpose: "x", body: `[[b:${brick.id}]] starts in March.` });
    const { sid } = await import("../../src/core/store.js");
    const revisionId = sid();
    await b.db.query(`INSERT INTO revisions (id, user_id, target_kind, target_id, his_text) VALUES ($1,$2,'page',$3,'It starts in April, not March.')`, [revisionId, b.ctx.userId, page.id]);
    await enqueue(b.ctx, { trigger: "you", job: "revision", purpose: "his revision", input: { revisionId } });
    await drain(b.ctx);
    expect((await b.rows(`SELECT 1 FROM stale_marks WHERE route='isaak'`)).length).toBe(1);
    expect((await b.rows<{ version: number }>(`SELECT version FROM pages WHERE id=$1`, [page.id]))[0].version).toBe(2);
    expect((await b.rows<{ status: string }>(`SELECT status FROM revisions WHERE id=$1`, [revisionId]))[0].status).toBe("applied");
    await b.close();
  });
});
