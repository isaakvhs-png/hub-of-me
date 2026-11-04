import { describe, expect, it } from "vitest";
import { fresh } from "./helpers.js";
import { addEntry, brickDetail, createBrick, learnFromUse, linkBricks, listAgenda, listBricks, listLinks, STRENGTH_CAP, warmthNow } from "../src/brain/store.js";
import { seedsFor, spread } from "../src/brain/spread.js";
import { intake } from "../src/brain/intake.js";
import { runSession } from "../src/brain/session.js";
import { runBrainTool } from "../src/brain/tools.js";

describe("the brick web", () => {
  it("files a text into bricks with moments, entries and links, and reuses a brick that already means the same thing", async () => {
    const { db, user, ai } = await fresh();
    const first = await intake(db, ai, user.id, { text: "Lorenzo showed a map\nWhy are dwarf mangroves relevant?", kind: "file", title: "notes.txt" });
    const bricks = await listBricks(db, user.id);
    expect(bricks.some((b) => b.kind === "source" && b.name === "notes.txt")).toBe(true);
    expect(first.created.length).toBeGreaterThanOrEqual(3);
    const lorenzo = bricks.find((b) => b.name.startsWith("Lorenzo showed"))!;
    const detail = await brickDetail(db, user.id, lorenzo.id);
    expect(detail?.moments[0].quote).toBe("Lorenzo showed a map");
    expect(detail?.moments[0].source).toBe("notes.txt");
    expect(detail?.links.some((l) => l.type === "source")).toBe(true);
    // The same thing again becomes a second moment on the same brick, not a duplicate.
    await intake(db, ai, user.id, { text: "Lorenzo showed a map", kind: "chat" });
    const again = await listBricks(db, user.id);
    expect(again.filter((b) => b.name.startsWith("Lorenzo showed")).length).toBe(1);
    expect((await brickDetail(db, user.id, lorenzo.id))?.moments.length).toBe(2);
  });

  it("spreads energy from what a text names, along links, fading with every step", async () => {
    const { db, user } = await fresh();
    const a = await createBrick(db, user.id, { name: "Lorenzo" });
    const b = await createBrick(db, user.id, { name: "Gulf mangroves" });
    const c = await createBrick(db, user.id, { name: "Dwarf mangroves" });
    const d = await createBrick(db, user.id, { name: "Sandbag training" });
    await linkBricks(db, user.id, { a, b, type: "about", strength: 4 });
    await linkBricks(db, user.id, { a: b, b: c, type: "about", strength: 4 });
    const bricks = await listBricks(db, user.id);
    const seeds = seedsFor("Lorenzo is sending me that map tomorrow.", bricks);
    expect([...seeds.keys()]).toEqual([a]);
    const energy = spread(bricks, await listLinks(db, user.id), seeds, () => 0.5);
    expect(energy.get(a)).toBe(1);
    expect(energy.get(b)!).toBeLessThan(1);
    expect(energy.get(c)!).toBeLessThan(energy.get(b)!);
    expect(energy.has(d)).toBe(false);
  });

  it("strengthens links between what was used together, up to a cap, and warms what was used", async () => {
    const { db, user } = await fresh();
    const a = await createBrick(db, user.id, { name: "Friend in Dubai" });
    const b = await createBrick(db, user.id, { name: "Lorenzo's map" });
    await learnFromUse(db, user.id, [a, b]);
    let links = await listLinks(db, user.id);
    expect(links).toHaveLength(1);
    expect(links[0].type).toBe("used");
    for (let i = 0; i < 30; i += 1) await learnFromUse(db, user.id, [a, b]);
    links = await listLinks(db, user.id);
    expect(links[0].strength).toBeLessThanOrEqual(STRENGTH_CAP);
    const warm = (await listBricks(db, user.id)).find((x) => x.id === a)!;
    expect(warm.warmth).toBeGreaterThan(0.9);
    expect(warmthNow(1, new Date(Date.now() - 24 * 3_600_000).toISOString())).toBeLessThan(0.1);
  });

  it("closes entries and agenda items as concrete wins, and only puts contact details on people", async () => {
    const { db, user } = await fresh();
    const q = await createBrick(db, user.id, { name: "Cloud mask" });
    const entryId = await addEntry(db, user.id, { brickId: q, kind: "question", text: "What is Google's cloud mask?", origin: "his" });
    expect(await runBrainTool(db, user.id, "entry_close", { id: entryId, status: "answered", note: "Cloud Score+" })).toContain("answered");
    expect(await runBrainTool(db, user.id, "brick_add", { id: q, contact: "x@y.org" })).toContain("only go on person bricks");
    const added = await runBrainTool(db, user.id, "agenda_add", { kind: "suggestion", text: "Draft an intro to Åke, for him to send" });
    const agendaId = added!.match(/\[(a\w+)\]/)![1];
    expect((await listAgenda(db, user.id, { open: true })).length).toBe(1);
    expect(await runBrainTool(db, user.id, "agenda_close", { id: agendaId, status: "done", note: "drafted" })).toContain("done");
    expect(await runBrainTool(db, user.id, "link", { a: q, b: q, type: "insight" })).toContain("two different bricks");
    expect(await runBrainTool(db, user.id, "not_a_brain_tool", {})).toBeNull();
  });

  it("runs a work session of its own: a goal, steps, a win, where it left off", async () => {
    const { db, user, ai } = await fresh();
    await intake(db, ai, user.id, { text: "Something about the Gulf\nA question about maps?", kind: "chat" });
    const result = await runSession(db, ai, user.id, { capEurCents: 50 });
    expect(result.goal).toContain("Look at what came in");
    expect(result.endedWhy).toBe("it reached a satisfying point");
    expect(result.wins).toContain("pursuit");
    expect((await listAgenda(db, user.id)).map((a) => a.text)).toContain("Understand what he cares about most");
    const row = (await db.query(`SELECT log, left_off FROM brain_sessions WHERE id = $1`, [result.sessionId])).rows[0];
    expect(JSON.parse(String(row.log)).length).toBe(2);
    expect(String(row.left_off)).toContain("next time");
  });
});

describe("the Mind page's data", () => {
  it("serves the web, the agenda, sessions and the last activation", async () => {
    const { createDb, migrate } = await import("../src/db.js");
    const { ensureUser } = await import("../src/seed.js");
    const { createApp } = await import("../server/app.js");
    const db = await createDb({ memory: true });
    await migrate(db);
    await ensureUser(db, { email: "peter@test", password: "secret", name: "Peter", provider: "mock" });
    const app = createApp(db);
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "peter@test", password: "secret" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    await (await app.request("/api/dump/stream", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Lorenzo showed a map\nWhy are dwarf mangroves relevant?" }) })).text();
    const res = await app.request("/api/brain", { headers: { cookie } });
    const body = await res.json() as { bricks: { name: string; moments: string[] }[]; activation: { cause: string } | null };
    expect(body.bricks.some((b) => b.name.startsWith("Lorenzo showed") && b.moments.length === 1)).toBe(true);
    expect(body.activation?.cause).toBe("his message");
    await db.close();
  });
});

describe("answers handed over one level deep", () => {
  it("unwraps {\"object\": {...}} instead of reading it as an empty answer", async () => {
    const { unwrapJson } = await import("../src/ai/tracked.js");
    const inner = { items: [{ name: "Wetlands International" }], links: [] };
    expect(unwrapJson({ object: inner })).toEqual(inner);
    expect(unwrapJson({ object: JSON.stringify(inner) })).toEqual(inner);
    expect(unwrapJson(inner)).toEqual(inner);
    expect(unwrapJson({ say: "hi" })).toEqual({ say: "hi" });
  });
});
