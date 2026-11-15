import { beforeEach, describe, expect, it } from "vitest";
import { fresh, drain } from "./helpers.js";
import { createApp } from "../server/app.js";
import { chatIdle } from "../src/chat.js";
import { db, live } from "../src/state.js";
import { setMock } from "../src/models.js";
import { scriptedModel } from "../src/mock.js";

let app: ReturnType<typeof createApp>;
let cookie = "";

async function req(path: string, opts: { method?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string>; auth?: boolean } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.auth !== false && cookie) headers.cookie = cookie;
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers["content-type"] = "application/json"; }
  const r = await app.request(`/api${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json, headers: r.headers };
}

beforeEach(async () => {
  await fresh();
  app = createApp();
  const r = await req("/login", { body: { email: "isaak@test", password: "pw" }, auth: false });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
});

describe("doors", () => {
  it("everything but health, login and inbound needs a sign-in", async () => {
    for (const p of ["/chat", "/web", "/projects", "/settings", "/live", "/proposals", "/calendar?from=2026-01-01&to=2026-02-01"]) {
      expect((await req(p, { auth: false })).status).toBe(401);
    }
    expect((await req("/healthz", { auth: false })).status).toBe(200);
  });
  it("a wrong password is refused plainly", async () => {
    const r = await req("/login", { body: { email: "isaak@test", password: "nope" }, auth: false });
    expect(r.status).toBe(401);
    expect(r.json.error).toMatch(/don't match/);
  });
  it("inbound is shut without its token", async () => {
    expect((await req("/inbound", { body: { text: "x" }, auth: false })).status).toBe(403);
    process.env.INBOUND_TOKEN = "t0k";
    expect((await req("/inbound", { body: { text: "Meeting moved to Tuesday", from: "boss@x", subject: "move" }, headers: { "x-inbound-token": "t0k" }, auth: false })).status).toBe(200);
    delete process.env.INBOUND_TOKEN;
    const r = await db().query(`SELECT origin FROM sources WHERE kind = 'email'`);
    expect(r.rows[0]).toEqual({ origin: "web" });
  });
  it("broken JSON, missing fields and unknown ids give plain errors, not 500s", async () => {
    const bad = await app.request("/api/chat", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{oops" });
    expect(bad.status).toBe(400);
    expect((await req("/chat", { body: { text: "   " } })).status).toBe(422);
    expect((await req("/summaries/nope")).status).toBe(404);
    expect((await req("/sources/nope")).status).toBe(404);
    expect((await req("/projects/nope")).status).toBe(404);
    expect((await req("/proposals/nope/accept", { body: {} })).status).toBe(404);
    expect((await req("/calendar/nope", { method: "DELETE" })).status).toBe(404);
    expect((await req("/summaries/nope/revise", { body: { words: "" } })).status).toBe(400);
  });
});

describe("the web, pushed", () => {
  it("my life can't be absorbed", async () => {
    const w = await req("/web");
    expect((await req(`/summaries/${w.json.lifeId}/absorb`, { method: "POST" })).status).toBe(422);
  });
  it("any file is taken: unreadable ones are stored and marked", async () => {
    const form = new FormData();
    form.set("text", "");
    form.append("files", new File([new Uint8Array([0, 1, 2, 3, 255])], "clip.mp4"));
    form.append("files", new File([""], "empty.txt"));
    form.append("files", new File(["%PDF-broken"], "broken.pdf"));
    form.append("files", new File(["naïve café ✓ 日本"], "notes.md"));
    const r = await app.request("/api/chat", { method: "POST", headers: { cookie }, body: form });
    expect(r.status).toBe(200);
    await chatIdle();
    const rows = await db().query<{ file_name: string; readable: boolean; text: string }>(`SELECT file_name, readable, text FROM sources WHERE kind = 'file' ORDER BY file_name`);
    const by = Object.fromEntries(rows.rows.map((x) => [x.file_name, x]));
    expect(by["clip.mp4"].readable).toBe(false);
    expect(by["broken.pdf"].readable).toBe(false);
    expect(by["empty.txt"].readable).toBe(false);
    expect(by["notes.md"].text).toContain("日本");
    const file = await app.request(`/api/sources/${(await db().query<{ id: string }>(`SELECT id FROM sources WHERE file_name = 'clip.mp4'`)).rows[0].id}/file`, { headers: { cookie } });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3, 255]));
    await drain();
  });
  it("a big upload goes in whole", async () => {
    const big = "x".repeat(5_000_000);
    const form = new FormData();
    form.set("text", "a big file");
    form.append("files", new File([big], "big.txt"));
    const r = await app.request("/api/chat", { method: "POST", headers: { cookie }, body: form });
    expect(r.status).toBe(200);
    await chatIdle();
    const row = await db().query<{ size: number }>(`SELECT size FROM sources WHERE file_name = 'big.txt'`);
    expect(row.rows[0].size).toBe(5_000_000);
  });
  it("twenty messages at once are all answered, in order", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => req("/chat", { body: { text: `message ${i}` } })));
    await chatIdle();
    const h = await req("/chat");
    expect(h.json.filter((m: any) => m.role === "it")).toHaveLength(20);
    await drain(200);
    const unplaced = await db().query(`SELECT 1 FROM sources WHERE placed = false`);
    expect(unplaced.rows).toHaveLength(0);
  });
  it("editing, revising and history work through the doors", async () => {
    await req("/chat", { body: { text: "internship at Arcadis" } }); await chatIdle(); await drain();
    const w = await req("/web");
    const child = w.json.summaries.find((s: any) => !s.is_life);
    expect((await req(`/summaries/${child.id}/edit`, { body: { body: "" } })).status).toBe(200);
    expect((await req(`/summaries/${child.id}/revise`, { body: { words: "make it shorter" } })).json.action).toBe("rewrite");
    const v = await req(`/summaries/${child.id}?touch=0`);
    expect(v.json.versions.length).toBeGreaterThanOrEqual(2);
  });
  it("the chat's stop answers at once", async () => {
    await req("/chat", { body: { text: "internship" } }); await chatIdle(); await drain();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    setMock(async (o) => { if (o.task === "chat" && !/answer NOW/.test(o.prompt)) { await gate; } return scriptedModel(o); });
    await req("/chat", { body: { text: "what about my internship?" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(live.chat.busy).toBe(true);
    await req("/chat/stop", { method: "POST" });
    release();
    await chatIdle();
    const h = await req("/chat");
    const last = h.json[h.json.length - 1];
    expect(last.role).toBe("it");
  });
});

describe("calendar, pushed", () => {
  it("refuses nonsense and accepts a normal appointment", async () => {
    expect((await req("/calendar", { body: { title: "x", startsAt: "tomorrow-ish" } })).status).toBe(422);
    expect((await req("/calendar", { body: { title: "", startsAt: "2026-11-20T10:00:00Z" } })).status).toBe(422);
    expect((await req("/calendar", { body: { title: "x", startsAt: "2026-11-20T10:00:00Z", endsAt: "2026-11-20T09:00:00Z" } })).status).toBe(422);
    const ok = await req("/calendar", { body: { title: "Lunch", startsAt: "2026-11-20T12:00:00Z" } });
    expect(ok.status).toBe(200);
    expect((await req(`/calendar/${ok.json.id}`, { method: "PATCH", body: { title: "Lunch with Sam" } })).status).toBe(200);
    expect((await req(`/calendar/${ok.json.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await req(`/calendar/${ok.json.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await req("/calendar?from=garbage&to=x")).status).toBe(422);
  });
});

describe("the workspace, pushed", () => {
  it("garbage boards are cleaned, not stored", async () => {
    const p = await req("/projects", { body: { title: "x" } });
    const r = await req(`/projects/${p.json.id}/board`, { body: { board: { pieces: [{ id: "a", type: "rocket", ref: "x" }, { id: "b", type: "model", ref: "gpt-9" }, { id: "c", type: "module", ref: "web-search" }], arrows: [{ from: "c", to: "c" }, { from: "zz", to: "c" }] } } });
    expect(r.status).toBe(200);
    const v = await req(`/projects/${p.json.id}`);
    expect(v.json.canon.board.pieces.map((x: any) => x.type).sort()).toEqual(["me", "module"]);
    expect(v.json.canon.board.arrows).toHaveLength(0);
  });
  it("go with no model on the board is a plain error", async () => {
    const p = await req("/projects", { body: { title: "x" } });
    const r = await req(`/projects/${p.json.id}/go`, { method: "POST" });
    expect(r.status).toBe(422);
  });
  it("models handing to each other in a circle are refused instead of waiting forever", async () => {
    const p = await req("/projects", { body: { title: "loop" } });
    await req(`/projects/${p.json.id}/board`, { body: { board: { pieces: [{ id: "a", type: "model", ref: "claude-haiku-5-5" }, { id: "b", type: "model", ref: "claude-haiku-5-5" }], arrows: [{ from: "a", to: "b", step: 1 }, { from: "b", to: "a", step: 1 }] } } });
    const r = await req(`/projects/${p.json.id}/go`, { method: "POST" });
    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/circle/);
  });
  it("accepting the same suggestion twice is refused the second time", async () => {
    const p = await req("/projects", { body: { title: "x" } });
    await req(`/projects/${p.json.id}/talk`, { body: { text: "build something" } });
    const v = await req(`/projects/${p.json.id}`);
    const m = v.json.messages.find((x: any) => x.proposed_board);
    expect((await req(`/projects/${p.json.id}/accept`, { body: { messageId: m.id } })).status).toBe(200);
    expect((await req(`/projects/${p.json.id}/accept`, { body: { messageId: m.id } })).status).toBe(404);
  });
  it("a closed project can be reopened and closed again; its summary is updated, not doubled", async () => {
    const p = await req("/projects", { body: { title: "twice" } });
    await req(`/projects/${p.json.id}/talk`, { body: { text: "build something" } });
    const s1 = await req(`/projects/${p.json.id}/close`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 200));
    expect((await req("/live")).json.reopenable.map((x: any) => x.id)).toContain(p.json.id);
    await req(`/projects/${p.json.id}/talk`, { body: { text: "more" } });
    const s2 = await req(`/projects/${p.json.id}/close`, { method: "POST" });
    expect(s2.json.summaryId).toBe(s1.json.summaryId);
    const pick = await req(`/summaries/${s1.json.summaryId}/pickup`, { method: "POST" });
    expect(pick.json.projectId).toBe(p.json.id);
  });
  it("stop ends a run", async () => {
    const p = await req("/projects", { body: { title: "slow" } });
    await req(`/projects/${p.json.id}/board`, { body: { board: { pieces: [{ id: "a", type: "model", ref: "claude-haiku-5-5" }], arrows: [] } } });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    setMock(async (o) => { if (o.task === "board-step") await gate; return scriptedModel(o); });
    const go = await req(`/projects/${p.json.id}/go`, { method: "POST" });
    await req(`/projects/${p.json.id}/runs/${go.json.runId}/stop`, { method: "POST" });
    release();
    for (let i = 0; i < 40; i += 1) { const r = await db().query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [go.json.runId]); if (r.rows[0].status !== "running") break; await new Promise((x) => setTimeout(x, 50)); }
    const r = await db().query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [go.json.runId]);
    expect(["stopped", "done"]).toContain(r.rows[0].status);
  });
});

describe("proposals and settings, pushed", () => {
  it("a decided proposal can't be decided again", async () => {
    await req("/chat", { body: { text: "explore ecology" } }); await chatIdle(); await drain();
    const [p] = (await req("/proposals")).json;
    expect((await req(`/proposals/${p.id}/decline`, { body: { why: "" } })).status).toBe(200);
    expect((await req(`/proposals/${p.id}/accept`, { body: {} })).status).toBe(422);
  });
  it("knobs: unknown names are refused; the own-work switch stops its projects", async () => {
    expect((await req("/settings/knob", { body: { name: "nope", value: 1 } })).status).toBe(422);
    expect((await req("/settings/knob", { body: { name: "ownWork", value: false } })).status).toBe(200);
    const s = await req("/settings");
    expect(s.json.knobs.ownWork.value).toBe(false);
    expect(s.json.database.usedMb).toBeGreaterThan(0);
  });
});
