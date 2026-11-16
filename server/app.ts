import { Hono, type Context, type Next } from "hono";
import { z, ZodError } from "zod";
import { token } from "../src/ids.js";
import { NotFoundError, ValidationError } from "../src/errors.js";
import { ModelDownError, downRoles } from "../src/models.js";
import { checkLogin, createSession, endSession, userForToken } from "../src/accounts.js";
import { clearSession, hashToken, readSession, writeSession } from "./session.js";
import { db, liveView } from "../src/state.js";
import { dismissPopup, openPopups } from "../src/popups.js";
import { history, send, stop } from "../src/chat.js";
import { absorb, addSource, editByIsaak, revise, sourceFile, sourceView, summaryView, webView } from "../src/web.js";
import { addEvent, deleteEvent, listEvents, updateEvent } from "../src/calendar.js";
import { acceptSuggestion, closeProject, createProject, lego, listProjects, pickUp, projectView, reopen, setBoard, startRun, stopRun, talk } from "../src/projects.js";
import { buildPack, editPack, listPacks, packView } from "../src/packs.js";
import { acceptProposal, declineProposal, listProposals, reviseProposal } from "../src/proposals.js";
import { setKnob, settingsView } from "../src/settings.js";

type Env = { Variables: { userId: string } };

export function createApp() {
  const app = new Hono<Env>();

  app.onError((error, c) => {
    if (error instanceof SyntaxError && /JSON/i.test(error.message)) return c.json({ error: "The request body is not valid JSON." }, 400);
    if (error instanceof ZodError) return c.json({ error: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, 400);
    if (error instanceof ValidationError) return c.json({ error: error.message }, 422);
    if (error instanceof NotFoundError) return c.json({ error: error.message }, 404);
    if (error instanceof ModelDownError) return c.json({ error: error.message }, 503);
    console.error(error);
    return c.json({ error: "Something went wrong on the server." }, 500);
  });

  app.get("/api/healthz", async (c) => {
    let database = "unknown";
    try {
      await db().query("SELECT 1");
      const host = (() => { try { return new URL(process.env.DATABASE_URL ?? "").hostname; } catch { return ""; } })();
      const region = /\.([a-z]{2}-[a-z]+-\d)\./.exec(host)?.[1] ?? (host ? "elsewhere" : "local");
      database = `ok (${region})`;
    } catch (error) { database = `down: ${(error as Error).message.slice(0, 120)}`; }
    return c.json({ ok: true, commit: process.env.RENDER_GIT_COMMIT ?? "", database });
  });

  app.post("/api/login", async (c) => {
    const body = z.object({ email: z.string().min(1), password: z.string().min(1) }).parse(await c.req.json());
    const user = await checkLogin(body.email, body.password);
    if (!user) return c.json({ error: "That email and password don't match." }, 401);
    const t = token();
    await createSession(user.id, hashToken(t));
    writeSession(c, t);
    return c.json({ ok: true, name: user.name });
  });

  // Inbound: anything coming in from outside (email, later) wakes it. Guarded by INBOUND_TOKEN.
  app.post("/api/inbound", async (c) => {
    const expected = process.env.INBOUND_TOKEN?.trim();
    if (!expected || c.req.header("x-inbound-token") !== expected) return c.json({ error: "Not allowed." }, 403);
    const body = z.object({ kind: z.string().default("email"), from: z.string().default(""), subject: z.string().default(""), text: z.string().min(1) }).parse(await c.req.json());
    const sourceId = await addSource({ kind: body.kind, origin: "web", title: `${body.kind === "email" ? "Email" : body.kind}${body.from ? ` from ${body.from}` : ""}${body.subject ? `: ${body.subject}` : ""}`, text: body.text });
    return c.json({ ok: true, sourceId });
  });

  const auth = async (c: Context<Env>, next: Next) => {
    const t = readSession(c);
    const user = t ? await userForToken(hashToken(t)) : null;
    if (!user) return c.json({ error: "Please sign in." }, 401);
    c.set("userId", user.id);
    await next();
  };
  app.use("/api/*", async (c, next) => {
    if (["/api/healthz", "/api/login", "/api/inbound"].includes(c.req.path)) return next();
    return auth(c, next);
  });

  app.post("/api/logout", async (c) => {
    const t = readSession(c);
    if (t) await endSession(hashToken(t));
    clearSession(c);
    return c.json({ ok: true });
  });
  app.get("/api/me", async (c) => {
    const r = await db().query<{ name: string; email: string }>(`SELECT name, email FROM users WHERE id = $1`, [c.get("userId")]);
    return c.json(r.rows[0] ?? {});
  });

  // ---------- live ----------
  app.get("/api/live", async (c) => {
    const reopenable = await db().query(`SELECT id, title, closed_at FROM projects WHERE status = 'closed' AND closed_at > now() - interval '24 hours' ORDER BY closed_at DESC`);
    return c.json({ ...liveView(), popups: await openPopups(), down: downRoles(), reopenable: reopenable.rows });
  });
  app.post("/api/popups/:id/dismiss", async (c) => { await dismissPopup(c.req.param("id")); return c.json({ ok: true }); });

  // ---------- chat ----------
  app.get("/api/chat", async (c) => c.json(await history(Number(c.req.query("limit") ?? 200) || 200)));
  app.post("/api/chat", async (c) => {
    const type = c.req.header("content-type") ?? "";
    let text = "";
    let tree = false;
    const files: { name: string; bytes: Buffer }[] = [];
    if (type.includes("multipart/form-data")) {
      const form = await c.req.formData();
      text = String(form.get("text") ?? "");
      tree = String(form.get("tree") ?? "") === "1";
      for (const entry of form.getAll("files")) {
        if (typeof entry === "string") continue;
        const f = entry as File;
        files.push({ name: f.name || "file", bytes: Buffer.from(await f.arrayBuffer()) });
      }
    } else {
      const body = z.object({ text: z.string(), tree: z.boolean().optional() }).parse(await c.req.json());
      text = body.text; tree = Boolean(body.tree);
    }
    if (!text.trim() && !files.length) throw new ValidationError("Write something or attach a file.");
    if (tree && !text.trim()) throw new ValidationError("Say how the tree should change.");
    return c.json(await send(text, files, tree));
  });
  app.post("/api/chat/stop", async (c) => { stop(); return c.json({ ok: true }); });

  // ---------- the web ----------
  app.get("/api/web", async (c) => c.json(await webView()));
  app.get("/api/summaries/:id", async (c) => c.json(await summaryView(c.req.param("id"), c.req.query("touch") !== "0")));
  app.post("/api/summaries/:id/edit", async (c) => {
    const body = z.object({ body: z.string() }).parse(await c.req.json());
    await editByIsaak(c.req.param("id"), body.body);
    return c.json({ ok: true });
  });
  app.post("/api/summaries/:id/revise", async (c) => {
    const body = z.object({ words: z.string().trim().min(1, "Say what you want changed.") }).parse(await c.req.json());
    return c.json(await revise(c.req.param("id"), body.words));
  });
  app.post("/api/summaries/:id/absorb", async (c) => { await absorb(c.req.param("id")); return c.json({ ok: true }); });
  app.post("/api/summaries/:id/pickup", async (c) => c.json({ projectId: await pickUp(c.req.param("id")) }));
  app.get("/api/sources/:id", async (c) => c.json(await sourceView(c.req.param("id"))));
  app.get("/api/sources/:id/file", async (c) => {
    const f = await sourceFile(c.req.param("id"));
    if (!f) throw new NotFoundError("This source has no file.");
    return c.body(new Uint8Array(f.bytes), 200, { "content-type": f.mime, "content-disposition": `inline; filename="${f.name.replace(/"/g, "")}"` });
  });

  // ---------- calendar ----------
  app.get("/api/calendar", async (c) => c.json(await listEvents(c.req.query("from") ?? "", c.req.query("to") ?? "")));
  const eventBody = z.object({ title: z.string().max(300), startsAt: z.string(), endsAt: z.string().optional(), allDay: z.boolean().optional(), note: z.string().max(5000).optional() });
  app.post("/api/calendar", async (c) => c.json({ id: await addEvent({ ...eventBody.parse(await c.req.json()), by: "isaak" }) }));
  app.patch("/api/calendar/:id", async (c) => { await updateEvent(c.req.param("id"), eventBody.partial().parse(await c.req.json())); return c.json({ ok: true }); });
  app.delete("/api/calendar/:id", async (c) => { await deleteEvent(c.req.param("id")); return c.json({ ok: true }); });

  // ---------- workspace ----------
  app.get("/api/projects", async (c) => c.json(await listProjects()));
  app.post("/api/projects", async (c) => {
    const body = z.object({ title: z.string().max(200).default("") }).parse(await c.req.json().catch(() => ({})));
    return c.json({ id: await createProject({ title: body.title || "A new project", owner: "isaak" }) });
  });
  app.get("/api/projects/:id", async (c) => c.json(await projectView(c.req.param("id"))));
  app.post("/api/projects/:id/talk", async (c) => {
    const body = z.object({ text: z.string().trim().min(1, "Say something.") }).parse(await c.req.json());
    const out = await talk(c.req.param("id"), body.text, "isaak");
    return c.json(out);
  });
  app.post("/api/projects/:id/accept", async (c) => {
    const body = z.object({ messageId: z.string() }).parse(await c.req.json());
    return c.json({ version: await acceptSuggestion(c.req.param("id"), body.messageId) });
  });
  app.post("/api/projects/:id/board", async (c) => {
    const body = z.object({ board: z.unknown() }).parse(await c.req.json());
    return c.json({ version: await setBoard(c.req.param("id"), body.board) });
  });
  app.post("/api/projects/:id/go", async (c) => c.json({ runId: await startRun(c.req.param("id"), "isaak") }));
  app.post("/api/projects/:id/runs/:runId/stop", async (c) => { stopRun(c.req.param("runId")); return c.json({ ok: true }); });
  app.post("/api/projects/:id/close", async (c) => {
    let shot: Buffer | null = null;
    if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
      const form = await c.req.formData();
      const f = form.get("screenshot");
      if (f && typeof f !== "string") shot = Buffer.from(await (f as File).arrayBuffer());
    }
    return c.json({ summaryId: await closeProject(c.req.param("id"), shot) });
  });
  app.post("/api/projects/:id/reopen", async (c) => { await reopen(c.req.param("id")); return c.json({ ok: true }); });
  app.get("/api/lego", async (c) => c.json(await lego()));
  app.post("/api/packs", async (c) => {
    const body = z.object({ title: z.string().default(""), prompt: z.string().trim().min(1, "Say what the pack is about.") }).parse(await c.req.json());
    return c.json({ id: await buildPack(body.title, body.prompt) });
  });
  app.get("/api/packs", async (c) => c.json((await listPacks()).map((p) => ({ id: p.id, title: p.title, description: p.description, created_at: p.created_at }))));
  app.get("/api/packs/:id", async (c) => c.json(await packView(c.req.param("id"))));
  app.patch("/api/packs/:id", async (c) => {
    const body = z.object({ content: z.string(), title: z.string().optional() }).parse(await c.req.json());
    await editPack(c.req.param("id"), body.content, body.title);
    return c.json({ ok: true });
  });

  // ---------- proposals ----------
  app.get("/api/proposals", async (c) => c.json(await listProposals()));
  app.post("/api/proposals/:id/accept", async (c) => {
    const body = z.object({ body: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json({ projectId: await acceptProposal(c.req.param("id"), body.body) });
  });
  app.post("/api/proposals/:id/revise", async (c) => {
    const body = z.object({ body: z.string(), title: z.string().optional() }).parse(await c.req.json());
    await reviseProposal(c.req.param("id"), body.body, body.title);
    return c.json({ ok: true });
  });
  app.post("/api/proposals/:id/decline", async (c) => {
    const body = z.object({ why: z.string().default(""), drop: z.boolean().default(false) }).parse(await c.req.json());
    await declineProposal(c.req.param("id"), body.why, body.drop);
    return c.json({ ok: true });
  });

  // ---------- connections and settings ----------
  app.get("/api/connections", async (c) => {
    const r = await db().query(`SELECT id, kind, label, created_at FROM connections ORDER BY created_at`);
    return c.json({ connections: r.rows, inbound: Boolean(process.env.INBOUND_TOKEN?.trim()) });
  });
  app.get("/api/settings", async (c) => c.json(await settingsView()));
  app.post("/api/settings/knob", async (c) => {
    const body = z.object({ name: z.string(), value: z.unknown() }).parse(await c.req.json());
    await setKnob(body.name, body.value);
    return c.json({ ok: true });
  });

  return app;
}
