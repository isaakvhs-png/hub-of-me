import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Db } from "../src/db.js";
import { BoundaryError, ValidationError } from "../src/errors.js";
import { token } from "../src/ids.js";
import { KNOBS } from "../src/knobs.js";
import { hashPassword, verifyPassword } from "../src/password.js";
import { SYSTEM_MAP } from "../src/self/map.js";
import { addCalendar, archiveCalendar, createSession, expireSession, getUser, getUserByEmail, listCalendar, moveCalendar, setPasswordHash, userIdForToken } from "../src/core/accounts.js";
import { subscribe } from "../src/core/bus.js";
import { CitationError } from "../src/core/pages.js";
import { ctxFor, send, type Upload } from "../src/core/index.js";
import { render } from "../src/core/look.js";
import { getPage, lifeDocument, listPages, members, pageLevels, pageVersions, themes } from "../src/core/pages.js";
import { enqueue, listRuns, tick } from "../src/core/queue.js";
import { getBrick, getSource, linksOf, listBricks, listEntries, listSources, listStream, sid } from "../src/core/store.js";
import { backlog, staleQueue } from "../src/core/upkeep.js";
import { decideProposal, listBench, listGoals, listProposals, listRequests, putOnBench, setBenchStatus } from "../src/core/workshop.js";
import { mountDiagnostics, redactSecrets, runRecord } from "./diag.js";
import { recordServerError } from "./error-log.js";
import { clearSession, hashToken, readSession, writeSession } from "./session.js";

type App = Hono<{ Variables: { userId: string } }>;

/** The rebuild's HTTP surface: one view's worth of routes, plus diagnostics. */
export function createApp(db: Db): App {
  const app: App = new Hono();

  app.onError((error, c) => {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    const status = error instanceof BoundaryError ? 403 : error instanceof ValidationError || error instanceof CitationError || error instanceof z.ZodError ? 422 : 500;
    recordServerError({ at: new Date().toISOString(), method: c.req.method, path: c.req.path, status, message });
    if (status === 500) console.error(error);
    return c.json({ error: message }, status);
  });

  app.get("/api/healthz", async (c) => {
    const beat = (await db.query<{ at: unknown }>(`SELECT max(at) AS at FROM heartbeat`)).rows[0]?.at;
    return c.json({ ok: true, lastHeartbeat: beat ?? null, commit: process.env.RENDER_GIT_COMMIT ?? null });
  });

  mountDiagnostics(app, db);

  app.use("/api/*", async (c, next) => {
    const path = c.req.path;
    if (path === "/api/auth/login" || path === "/api/healthz" || path.startsWith("/api/diag")) return next();
    const raw = readSession(c);
    const userId = raw ? await userIdForToken(db, hashToken(raw)) : null;
    if (!userId) return c.json({ error: "Sign in." }, 401);
    c.set("userId", userId);
    await next();
  });

  // ---------- account ----------
  app.post("/api/auth/login", async (c) => {
    const body = z.object({ email: z.string().min(3), password: z.string().min(1) }).parse(await c.req.json());
    const user = await getUserByEmail(db, body.email);
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) return c.json({ error: "Email or password is wrong." }, 401);
    const raw = token();
    await createSession(db, user.id, hashToken(raw), new Date(Date.now() + 30 * 86_400_000).toISOString());
    writeSession(c, raw);
    return c.json({ id: user.id, email: user.email, name: user.name });
  });
  app.post("/api/auth/logout", async (c) => {
    const raw = readSession(c);
    if (raw) await expireSession(db, hashToken(raw));
    clearSession(c);
    return c.json({ ok: true });
  });
  app.get("/api/auth/me", async (c) => c.json(await getUser(db, c.get("userId"))));
  app.post("/api/auth/password", async (c) => {
    const body = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8) }).parse(await c.req.json());
    const user = await getUser(db, c.get("userId"));
    const full = user ? await getUserByEmail(db, user.email) : null;
    if (!full || !(await verifyPassword(body.currentPassword, full.passwordHash))) return c.json({ error: "Current password is wrong." }, 401);
    await setPasswordHash(db, full.id, await hashPassword(body.newPassword));
    return c.json({ ok: true });
  });

  // ---------- live: server-sent events ----------
  app.get("/api/events", (c) => {
    const userId = c.get("userId");
    return streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const off = subscribe(userId, (event) => { queue.push(JSON.stringify(event)); wake?.(); });
      stream.onAbort(() => { off(); wake?.(); });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ at: new Date().toISOString() }) });
      while (!stream.aborted) {
        if (!queue.length) {
          await Promise.race([new Promise<void>((r) => { wake = r; }), new Promise<void>((r) => setTimeout(r, 25_000))]);
          wake = null;
          if (!queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
          continue;
        }
        const data = queue.shift()!;
        await stream.writeSSE({ event: "live", data });
      }
      off();
    });
  });

  // ---------- chat ----------
  app.get("/api/chat", async (c) => c.json(await listStream(await ctxFor(db, c.get("userId")), Number(c.req.query("limit") ?? 200))));
  app.post("/api/send", async (c) => {
    const ctx = await ctxFor(db, c.get("userId"));
    let text = "";
    let clientMsgId: string | undefined;
    const files: Upload[] = [];
    if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
      const form = await c.req.parseBody({ all: true });
      text = String(form.text ?? "");
      clientMsgId = form.clientMsgId ? String(form.clientMsgId) : undefined;
      const raw = form.files;
      for (const f of (Array.isArray(raw) ? raw : raw ? [raw] : []) as unknown[]) {
        if (f && typeof f === "object" && "arrayBuffer" in f) {
          const file = f as File;
          files.push({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
        }
      }
    } else {
      const body = z.object({ text: z.string().default(""), clientMsgId: z.string().optional() }).parse(await c.req.json());
      text = body.text;
      clientMsgId = body.clientMsgId;
    }
    if (!text.trim() && !files.length) throw new ValidationError("Send a message or a file.");
    const result = await send(ctx, { text, clientMsgId, files });
    void tick(ctx);
    return c.json({ streamId: result.stream.id, runId: result.run?.id ?? null, duplicate: result.duplicate, clientMsgId: clientMsgId ?? null });
  });

  // ---------- the map, knobs, runs ----------
  app.get("/api/map", (c) => c.json(SYSTEM_MAP));
  app.get("/api/knobs", (c) => c.json(KNOBS));
  app.get("/api/runs", async (c) => c.json(await listRuns(await ctxFor(db, c.get("userId")), { limit: Number(c.req.query("limit") ?? 60) })));
  app.get("/api/runs/:id", async (c) => {
    const record = await runRecord(db, c.get("userId"), c.req.param("id"));
    return record ? c.json(record) : c.json({ error: "No such run." }, 404);
  });
  app.get("/api/runs/:id/export", async (c) => {
    const record = await runRecord(db, c.get("userId"), c.req.param("id"));
    if (!record) return c.json({ error: "No such run." }, 404);
    const body = JSON.stringify(redactSecrets({ exportedAt: new Date().toISOString(), note: "One run of Hub of Me: every step with its time, the pack (references) and what was used. Hand it to any AI.", ...record }), null, 2);
    return c.body(body, 200, { "content-type": "application/json", "content-disposition": `attachment; filename="hub-run-${c.req.param("id")}.json"` });
  });

  // ---------- memory: the rings and what is in them ----------
  app.get("/api/rings", async (c) => {
    const ctx = await ctxFor(db, c.get("userId"));
    const [bricks, pages, sources, levels, th, life] = await Promise.all([listBricks(ctx), listPages(ctx), listSources(ctx, 300), pageLevels(ctx), themes(ctx), lifeDocument(ctx)]);
    const memberRows = (await db.query<{ page_id: string; member_kind: string; member_id: string }>(`SELECT page_id, member_kind, member_id FROM page_members WHERE user_id=$1 AND archived_at IS NULL`, [ctx.userId])).rows;
    const themeOf = new Map<string, string[]>();
    const down = (pageId: string, theme: string, seen: Set<string>) => {
      if (seen.has(pageId)) return;
      seen.add(pageId);
      for (const m of memberRows.filter((r) => r.page_id === pageId)) {
        themeOf.set(m.member_id, [...new Set([...(themeOf.get(m.member_id) ?? []), theme])]);
        if (m.member_kind === "page") down(m.member_id, theme, seen);
      }
    };
    for (const t of th) { themeOf.set(t.id, [t.id]); down(t.id, t.id, new Set()); }
    const own = pages.filter((p) => p.kind === "guide" || p.kind === "track");
    const links = (await db.query<{ a: string; b: string }>(`SELECT a, b FROM links WHERE user_id=$1 AND archived_at IS NULL LIMIT 3000`, [ctx.userId])).rows;
    return c.json({
      life: life ? { id: life.id, title: life.title, chars: life.body.length } : null,
      themes: th.map((t) => ({ id: t.id, title: t.title, size: memberRows.filter((r) => (themeOf.get(r.member_id) ?? []).includes(t.id)).length + 1 })),
      pages: pages.filter((p) => p.kind !== "life").map((p) => ({ id: p.id, title: p.title, kind: p.kind, level: levels.get(p.id) ?? 1, status: p.status, themes: own.includes(p) ? ["own"] : themeOf.get(p.id) ?? [] })),
      bricks: bricks.filter((b) => b.kind !== "source").map((b) => ({ id: b.id, name: b.name, corner: b.corner, themes: b.corner === "own" ? ["own"] : themeOf.get(b.id) ?? [] })),
      sources: sources.map((s) => ({ id: s.id, title: s.title, kind: s.kind })),
      links,
    });
  });
  app.get("/api/node/:id", async (c) => {
    const ctx = await ctxFor(db, c.get("userId"));
    const id = c.req.param("id");
    const page = await getPage(ctx, id);
    if (page) return c.json({ kind: "page", page, members: await members(ctx, id), versions: await pageVersions(ctx, id) });
    const brick = await getBrick(ctx, id);
    if (brick) return c.json({ kind: "brick", brick, entries: await listEntries(ctx, id), links: await linksOf(ctx, id), text: await render(ctx, { kind: "brick", id }) });
    const source = await getSource(ctx, id);
    if (source) return c.json({ kind: "source", source });
    return c.json({ error: "Nothing with that id." }, 404);
  });

  // ---------- workshop ----------
  app.get("/api/workshop", async (c) => {
    const ctx = await ctxFor(db, c.get("userId"));
    const [bench, proposals, requests, goals, queue, stale] = await Promise.all([listBench(ctx), listProposals(ctx), listRequests(ctx), listGoals(ctx), listRuns(ctx, { status: ["queued", "running", "paused"], limit: 30 }), staleQueue(ctx)]);
    const reports = (await db.query(`SELECT id, scale, period, body, created_at FROM reports WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [ctx.userId])).rows;
    const threads = (await db.query(`SELECT target_kind, target_id, his_text, its_reply, status, created_at FROM revisions WHERE user_id=$1 ORDER BY created_at`, [ctx.userId])).rows;
    return c.json({ bench, proposals, requests, goals, queue, reports, threads, backlog: await backlog(ctx), staleTop: stale.slice(0, 10), knobs: KNOBS });
  });
  app.post("/api/bench", async (c) => {
    const body = z.object({ kind: z.enum(["note", "todo"]), title: z.string().min(1), body: z.string().default("") }).parse(await c.req.json());
    const ctx = await ctxFor(db, c.get("userId"));
    return c.json(await putOnBench(ctx, { ...body, origin: "his" }));
  });
  app.post("/api/bench/:id", async (c) => {
    const body = z.object({ status: z.enum(["open", "done", "dismissed", "used"]), note: z.string().default("") }).parse(await c.req.json());
    await setBenchStatus(await ctxFor(db, c.get("userId")), c.req.param("id"), body.status, body.note);
    return c.json({ ok: true });
  });
  app.post("/api/proposals/:id/decide", async (c) => {
    const body = z.object({ decision: z.enum(["yes", "not_now", "no", "revise", "discuss", "live"]), why: z.string().default("") }).parse(await c.req.json());
    if (body.decision === "no" && !body.why.trim()) throw new ValidationError("Say why: a declined proposal stays visible with your reason.");
    const ctx = await ctxFor(db, c.get("userId"));
    await decideProposal(ctx, c.req.param("id"), body.decision, body.why);
    if (body.decision === "discuss" || body.decision === "revise") {
      await enqueue(ctx, { trigger: "you", job: "discuss", purpose: `Discuss a proposal with Isaak`, input: { proposalId: c.req.param("id"), text: body.why || (body.decision === "revise" ? "Please revise this." : "Let's discuss this.") } });
      void tick(ctx);
    }
    return c.json({ ok: true });
  });
  app.post("/api/revise", async (c) => {
    const body = z.object({ targetKind: z.enum(["page", "brick", "request", "bench", "guide"]), targetId: z.string().min(1), text: z.string().min(1) }).parse(await c.req.json());
    const ctx = await ctxFor(db, c.get("userId"));
    const revisionId = sid();
    const kind = body.targetKind === "guide" ? "page" : body.targetKind;
    await db.query(`INSERT INTO revisions (id, user_id, target_kind, target_id, his_text, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [revisionId, ctx.userId, kind, body.targetId, body.text, new Date().toISOString()]);
    const run = await enqueue(ctx, { trigger: "you", job: "revision", purpose: `Isaak revised a ${kind}`, input: { revisionId } });
    void tick(ctx);
    return c.json({ revisionId, runId: run.id });
  });
  app.post("/api/attention", async (c) => {
    const body = z.object({ what: z.string().min(1).max(200), ms: z.number().int().min(0).max(3_600_000) }).parse(await c.req.json());
    await db.query(`INSERT INTO attention (id, user_id, what, ms, at) VALUES ($1,$2,$3,$4,now())`, [sid(), c.get("userId"), body.what, body.ms]);
    return c.json({ ok: true });
  });

  // ---------- calendar (kept as is) ----------
  app.get("/api/calendar", async (c) => {
    const from = c.req.query("from") ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
    const to = c.req.query("to") ?? new Date(Date.now() + 21 * 86_400_000).toISOString();
    return c.json(await listCalendar(await ctxFor(db, c.get("userId")), from, to));
  });
  app.post("/api/calendar", async (c) => {
    const body = z.object({ title: z.string().min(1), startsAt: z.string(), endsAt: z.string().optional(), allDay: z.boolean().optional(), why: z.string().default("added by Isaak") }).parse(await c.req.json());
    return c.json({ id: await addCalendar(await ctxFor(db, c.get("userId")), { ...body, source: "his" }) });
  });
  app.post("/api/calendar/:id/move", async (c) => {
    const body = z.object({ startsAt: z.string(), endsAt: z.string().optional() }).parse(await c.req.json());
    await moveCalendar(await ctxFor(db, c.get("userId")), c.req.param("id"), body.startsAt, body.endsAt);
    return c.json({ ok: true });
  });
  app.post("/api/calendar/:id/archive", async (c) => {
    await archiveCalendar(await ctxFor(db, c.get("userId")), c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}
