import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { keysPresent, providerReport } from "../src/ai/router.js";
import { MockProvider } from "../src/ai/mock.js";
import { Router } from "../src/ai/router.js";
import { toDocx } from "../src/docx-export.js";
import type { Db } from "../src/db.js";
import { BoundaryError, BudgetError, UnpricedModelError, UsageMissingError, ValidationError } from "../src/errors.js";
import { healthReport } from "../src/health.js";
import { id, token } from "../src/ids.js";
import { textFromUpload } from "../src/ingest.js";
import { assertGmailReadOnly, assertGrantedScopes, gmailAuthUrl, gmailModule } from "../src/modules/gmail.js";
import { hashPassword, verifyPassword } from "../src/password.js";
import { archiveNote, runDump, undoNote } from "../src/pipeline/dump.js";
import { runReflection } from "../src/pipeline/debate.js";
import { runNightly, runResearch, writeBrief } from "../src/pipeline/jobs.js";
import {
  addMessage,
  archiveEvent,
  createConversation,
  getConversation,
  ensureFolderPath,
  expireSession,
  followDiscovery,
  getDebate,
  getModule,
  getNote,
  getSettings,
  getSoul,
  getUserByEmail,
  getUserById,
  getUserWithPassword,
  setUserPasswordHash,
  insertEvent,
  insertFeedback,
  insertNote,
  insertSource,
  listActions,
  listBriefs,
  listConflicts,
  listConversations,
  listDebateSides,
  listDebates,
  listDiscovery,
  listEvents,
  listFeedback,
  listFolders,
  listInfoRequests,
  listJobs,
  listMessages,
  listNoteVersions,
  listNotes,
  listOutreach,
  listPicture,
  listPredictions,
  listPreferences,
  listSoulVersions,
  listSources,
  logAction,
  reviseNote,
  setBudget,
  insertDebateFeedback,
  listDebateFeedback,
  setPredictionOutcome,
  updateInfoRequest,
  updateSettings,
  upsertModule,
  userIdForToken,
  createSession,
  getBudget,
  insertRecording,
  listUsage,
} from "../src/repo.js";
import { changeSoul, undoSoul } from "../src/soul.js";
import type { Settings } from "../src/types.js";
import { mountDiagnostics } from "./diag.js";
import { recordServerError } from "./error-log.js";
import { scheduleFeedbackDrain } from "../src/feedback.js";
import { clearSession, hashToken, readSession, writeSession } from "./session.js";

const sharedMock = new MockProvider();

function aiFor(settings: Settings): Router {
  return new Router(settings, { mock: settings.provider === "mock" ? sharedMock : undefined });
}

const loginSchema = z.object({
  email: z.string().min(3).refine((value) => value.includes("@"), "Enter an email."),
  password: z.string().min(1),
});

export function createApp(db: Db) {
  const app = new Hono<{ Variables: { userId: string } }>();

  app.onError((error, c) => {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    const status =
      error instanceof BoundaryError ? 403 : error instanceof BudgetError ? 402 : error instanceof UnpricedModelError || error instanceof UsageMissingError || error instanceof ValidationError ? 422 : 500;
    recordServerError({ at: new Date().toISOString(), method: c.req.method, path: c.req.path, status, message });
    if (status === 403) return c.json({ error: message }, 403);
    if (status === 402) return c.json({ error: message }, 402);
    if (status === 422) return c.json({ error: message }, 422);
    console.error(error);
    return c.json({ error: message }, 500);
  });

  app.get("/api/healthz", (c) => c.json({ ok: true }));

  mountDiagnostics(app, db);

  app.use("/api/*", async (c, next) => {
    const path = c.req.path;
    if (path === "/api/auth/login" || path === "/api/healthz" || path.startsWith("/api/diag")) return next();
    const raw = readSession(c);
    if (!raw) return c.json({ error: "Sign in." }, 401);
    const userId = await userIdForToken(db, hashToken(raw));
    if (!userId) return c.json({ error: "Sign in." }, 401);
    c.set("userId", userId);
    await next();
  });

  app.post("/api/auth/login", async (c) => {
    const body = loginSchema.parse(await c.req.json());
    const user = await getUserByEmail(db, body.email);
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return c.json({ error: "Email or password is wrong." }, 401);
    }
    const raw = token();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await createSession(db, user.id, hashToken(raw), expires);
    writeSession(c, raw);
    return c.json({ id: user.id, email: user.email, name: user.name });
  });

  app.post("/api/auth/logout", async (c) => {
    const raw = readSession(c);
    if (raw) await expireSession(db, hashToken(raw));
    clearSession(c);
    return c.json({ ok: true });
  });

  app.get("/api/auth/me", async (c) => {
    const user = await getUserById(db, c.get("userId"));
    return c.json(user);
  });

  app.post("/api/auth/password", async (c) => {
    const userId = c.get("userId");
    const body = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(1),
    }).parse(await c.req.json());
    if (body.newPassword.length < 8) throw new ValidationError("Use at least 8 characters.");
    const user = await getUserWithPassword(db, userId);
    if (!user || !(await verifyPassword(body.currentPassword, user.passwordHash))) {
      return c.json({ error: "Current password is wrong." }, 401);
    }
    await setUserPasswordHash(db, userId, await hashPassword(body.newPassword));
    await logAction(db, userId, {
      what: "password changed",
      why: "You changed the password in Settings. USER_PASSWORD replaces it the next time the server starts, when that variable is set.",
      source: "user",
      payload: {},
    });
    return c.json({ ok: true });
  });

  app.get("/api/summary", async (c) => {
    const userId = c.get("userId");
    const [user, notes, conflicts, budget, settings, health] = await Promise.all([
      getUserById(db, userId),
      listNotes(db, userId),
      listConflicts(db, userId),
      getBudget(db, userId),
      getSettings(db, userId),
      healthReport(db, userId),
    ]);
    return c.json({
      name: user?.name ?? "Peter",
      unexplored: notes.filter((note) => note.status === "unexplored").length,
      tensions: conflicts.filter((item) => !item.resolvedAt).length,
      capEurCents: budget.monthlyCapEurCents,
      leftEurCents: health.leftEurCents,
      provider: settings.provider,
    });
  });

  app.get("/api/conversations", async (c) => c.json(await listConversations(db, c.get("userId"))));

  app.post("/api/conversations", async (c) => {
    const body = z.object({ title: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
    const conversationId = await createConversation(db, c.get("userId"), body.title || "Dump");
    return c.json({ id: conversationId });
  });

  app.get("/api/conversations/:id/messages", async (c) => {
    const conversation = await getConversation(db, c.get("userId"), c.req.param("id"));
    if (!conversation) return c.json({ error: "Not found." }, 404);
    return c.json(await listMessages(db, c.req.param("id")));
  });

  app.post("/api/dump", async (c) => {
    const body = z.object({ text: z.string().min(1), conversationId: z.string().nullable().optional() }).parse(await c.req.json());
    const settings = await getSettings(db, c.get("userId"));
    const result = await runDump(db, aiFor(settings), c.get("userId"), { text: body.text, conversationId: body.conversationId });
    return c.json(result);
  });

  app.post("/api/voice", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.parseBody();
    const transcript = String(body.transcript ?? "").trim();
    const conversationId = body.conversationId ? String(body.conversationId) : null;
    const audio = body.audio;
    let path: string | undefined;
    let mime: string | undefined;
    let byteSize: number | undefined;
    if (audio && typeof audio === "object" && "arrayBuffer" in audio) {
      const bytes = Buffer.from(await audio.arrayBuffer());
      mime = audio.type || "audio/webm";
      byteSize = bytes.length;
      const recordingId = id();
      path = join("data", "recordings", `${recordingId}.webm`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      await insertRecording(db, userId, { transcript, mime, byteSize, path });
    } else {
      await insertRecording(db, userId, { transcript });
    }
    if (!transcript) {
      return c.json({ error: "No transcript yet. Type the words, or use a browser that can transcribe while recording.", path }, 422);
    }
    const settings = await getSettings(db, userId);
    const result = await runDump(db, aiFor(settings), userId, { text: transcript, conversationId });
    return c.json(result);
  });

  app.get("/api/folders", async (c) => c.json(await listFolders(db, c.get("userId"))));
  app.get("/api/notes", async (c) => c.json(await listNotes(db, c.get("userId"))));

  app.get("/api/notes/:id", async (c) => {
    const note = await getNote(db, c.get("userId"), c.req.param("id"));
    if (!note) return c.json({ error: "Note not found." }, 404);
    const versions = await listNoteVersions(db, note.id);
    return c.json({ note, versions });
  });

  app.post("/api/notes/:id", async (c) => {
    const userId = c.get("userId");
    const note = await getNote(db, userId, c.req.param("id"));
    if (!note) return c.json({ error: "Note not found." }, 404);
    const body = z.object({
      title: z.string().min(1),
      body: z.string().min(1),
      type: z.string().min(1),
      folder: z.string().min(1),
    }).parse(await c.req.json());
    const folderId = await ensureFolderPath(db, userId, body.folder);
    const saved = await reviseNote(db, userId, note.id, {
      folderId,
      type: body.type,
      title: body.title,
      body: body.body,
      status: note.status === "unexplored" ? "revised" : note.status,
      forNowExpiresAt: note.forNowExpiresAt,
      reason: "You edited the note.",
      causingMessageId: null,
      source: "user",
    });
    return c.json(saved);
  });

  app.post("/api/notes/:id/undo", async (c) => c.json(await undoNote(db, c.get("userId"), c.req.param("id"))));

  app.post("/api/notes/:id/archive", async (c) => {
    const body = z.object({ why: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await archiveNote(db, c.get("userId"), c.req.param("id"), body.why || "You archived it.", "user"));
  });

  app.post("/api/notes/:id/respond", async (c) => {
    const userId = c.get("userId");
    const note = await getNote(db, userId, c.req.param("id"));
    if (!note) return c.json({ error: "Note not found." }, 404);
    const body = z.object({ stance: z.enum(["yes", "no", "revise"]), body: z.string().optional() }).parse(await c.req.json());
    const status = body.stance === "yes" ? "acknowledged" : body.stance === "no" ? "declined" : "revised";
    const saved = await reviseNote(db, userId, note.id, {
      folderId: note.folderId,
      type: note.type,
      title: note.title,
      body: body.body?.trim() || note.body,
      status,
      forNowExpiresAt: note.forNowExpiresAt,
      reason: `You said ${body.stance}.`,
      causingMessageId: null,
      source: "user",
    });
    return c.json(saved);
  });

  app.get("/api/notes/:id/docx", async (c) => {
    const note = await getNote(db, c.get("userId"), c.req.param("id"));
    if (!note) return c.json({ error: "Note not found." }, 404);
    const bytes = await toDocx(note.title, note.body);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-disposition": `attachment; filename="${note.title.slice(0, 40)}.docx"`,
      },
    });
  });

  app.get("/api/soul", async (c) => {
    const userId = c.get("userId");
    return c.json({ current: await getSoul(db, userId), versions: await listSoulVersions(db, userId), picture: await listPicture(db, userId), preferences: await listPreferences(db, userId) });
  });

  app.post("/api/soul", async (c) => {
    const body = z.object({ content: z.string().min(1), reason: z.string().min(1) }).parse(await c.req.json());
    return c.json(await changeSoul(db, c.get("userId"), { content: body.content, reason: body.reason, via: "user" }));
  });

  app.post("/api/soul/undo", async (c) => c.json(await undoSoul(db, c.get("userId"))));

  app.get("/api/soul/docx", async (c) => {
    const soul = await getSoul(db, c.get("userId"));
    if (!soul) return c.json({ error: "No soul yet." }, 404);
    const bytes = await toDocx("Soul", soul.content);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-disposition": "attachment; filename=soul.docx",
      },
    });
  });

  app.get("/api/calendar", async (c) => {
    const from = c.req.query("from") ?? new Date(Date.now() - 40 * 86400000).toISOString();
    const to = c.req.query("to") ?? new Date(Date.now() + 40 * 86400000).toISOString();
    return c.json(await listEvents(db, c.get("userId"), from, to));
  });

  app.post("/api/calendar", async (c) => {
    const body = z.object({
      title: z.string().min(1),
      startsAt: z.string().min(1),
      endsAt: z.string().min(1),
      why: z.string().min(1),
    }).parse(await c.req.json());
    const eventId = await insertEvent(db, c.get("userId"), { ...body, source: "user" });
    return c.json({ id: eventId });
  });

  app.post("/api/calendar/:id/archive", async (c) => {
    await archiveEvent(db, c.get("userId"), c.req.param("id"), "You archived the event.");
    return c.json({ ok: true });
  });

  app.get("/api/discovery", async (c) => {
    const userId = c.get("userId");
    const [cards, sources] = await Promise.all([listDiscovery(db, userId), listSources(db, userId)]);
    return c.json({ cards, sources });
  });

  app.post("/api/discovery/:id/follow", async (c) => {
    const userId = c.get("userId");
    const cards = await listDiscovery(db, userId);
    const card = cards.find((item) => item.id === c.req.param("id"));
    if (!card) return c.json({ error: "Card not found." }, 404);
    const conversationId = String(card.conversationId ?? (await createConversation(db, userId, String(card.title), String(card.id))));
    await followDiscovery(db, userId, String(card.id), conversationId);
    await addMessage(db, conversationId, "assistant", String(card.finding));
    await logAction(db, userId, { what: "followed a discovery card", why: "You wanted the thread kept with the card.", source: "user", payload: { cardId: card.id, conversationId } });
    return c.json({ conversationId });
  });

  app.post("/api/research", async (c) => {
    const body = z.object({ topic: z.string().min(1) }).parse(await c.req.json());
    const settings = await getSettings(db, c.get("userId"));
    return c.json(await runResearch(db, aiFor(settings), c.get("userId"), body.topic));
  });

  app.get("/api/brief", async (c) => c.json(await listBriefs(db, c.get("userId"))));

  app.post("/api/brief", async (c) => {
    const settings = await getSettings(db, c.get("userId"));
    return c.json(await writeBrief(db, aiFor(settings), c.get("userId")));
  });

  app.get("/api/asks", async (c) => c.json(await listInfoRequests(db, c.get("userId"))));

  app.post("/api/asks/:id", async (c) => {
    const body = z.object({
      action: z.enum(["answer", "postpone", "never"]),
      answer: z.string().optional(),
    }).parse(await c.req.json());
    const userId = c.get("userId");
    if (body.action === "answer") {
      await updateInfoRequest(db, userId, c.req.param("id"), { status: "answered", answer: body.answer ?? "" });
      if (body.answer?.trim()) await insertFeedback(db, userId, body.answer.trim(), "info-request");
    } else if (body.action === "postpone") {
      const until = new Date(Date.now() + 3 * 86400000).toISOString();
      await updateInfoRequest(db, userId, c.req.param("id"), { status: "postponed", postponeUntil: until });
    } else {
      await updateInfoRequest(db, userId, c.req.param("id"), { status: "never" });
    }
    await logAction(db, userId, { what: `info request ${body.action}`, why: "You answered a question the system asked.", source: "user", payload: { id: c.req.param("id") } });
    return c.json({ ok: true });
  });

  app.get("/api/debates", async (c) => c.json(await listDebates(db, c.get("userId"))));

  app.get("/api/debates/:id", async (c) => {
    const userId = c.get("userId");
    const debate = await getDebate(db, userId, c.req.param("id"));
    if (!debate) return c.json({ error: "Debate not found." }, 404);
    const [sides, feedback, predictions] = await Promise.all([
      listDebateSides(db, c.req.param("id")),
      listDebateFeedback(db, c.req.param("id")),
      listPredictions(db, userId),
    ]);
    let triggeredBy: { debateId: string; question: string; feedback: string } | null = null;
    if (debate.triggeredByDebateId) {
      const source = await getDebate(db, userId, String(debate.triggeredByDebateId));
      const sourceFeedback = debate.triggeredByFeedbackId
        ? (await listDebateFeedback(db, String(debate.triggeredByDebateId))).find((item) => item.id === debate.triggeredByFeedbackId)
        : null;
      triggeredBy = {
        debateId: String(debate.triggeredByDebateId),
        question: String(source?.question ?? "the earlier debate"),
        feedback: sourceFeedback?.body ?? "",
      };
    }
    return c.json({
      debate,
      sides,
      predictions: predictions.filter((item) => item.debateId === c.req.param("id")),
      feedback,
      triggeredBy,
    });
  });

  app.post("/api/debates/:id/rerun", async (c) => {
    const userId = c.get("userId");
    const debate = await getDebate(db, userId, c.req.param("id"));
    if (!debate) return c.json({ error: "Debate not found." }, 404);
    if (String(debate.status) !== "failed") return c.json({ error: "Only a failed debate can be run again." }, 422);
    const settings = await getSettings(db, userId);
    const reflection = await runReflection(db, aiFor(settings), userId, { cause: `Re-run after a failed debate. ${String(debate.whyWon ?? "")}`.trim() });
    return c.json({ reflection });
  });

  app.post("/api/debates/:id/feedback", async (c) => {
    const body = z.object({ text: z.string().min(1) }).parse(await c.req.json());
    const userId = c.get("userId");
    const debate = await getDebate(db, userId, c.req.param("id"));
    if (!debate) return c.json({ error: "Debate not found." }, 404);
    const saved = await insertDebateFeedback(db, userId, c.req.param("id"), body.text);
    await insertFeedback(db, userId, body.text, `debate:${c.req.param("id")}`);
    scheduleFeedbackDrain(db, userId, async () => aiFor(await getSettings(db, userId)));
    return c.json({ feedback: saved, queued: true });
  });

  app.get("/api/predictions", async (c) => c.json(await listPredictions(db, c.get("userId"))));

  app.post("/api/predictions/:id", async (c) => {
    const body = z.object({ cameTrue: z.boolean(), observed: z.string().min(1) }).parse(await c.req.json());
    await setPredictionOutcome(db, c.get("userId"), c.req.param("id"), body);
    await logAction(db, c.get("userId"), { what: "prediction checked", why: body.observed, source: "user", payload: { id: c.req.param("id"), cameTrue: body.cameTrue } });
    return c.json({ ok: true });
  });

  app.get("/api/why", async (c) => {
    const userId = c.get("userId");
    const [actions, conflicts] = await Promise.all([listActions(db, userId, 300), listConflicts(db, userId)]);
    return c.json({ actions, conflicts });
  });

  app.get("/api/health", async (c) => c.json(await healthReport(db, c.get("userId"))));

  app.get("/api/settings", async (c) => {
    const userId = c.get("userId");
    const [settings, budget, moduleRow] = await Promise.all([getSettings(db, userId), getBudget(db, userId), getModule(db, userId, "gmail")]);
    return c.json({
      settings,
      budget,
      gmail: { enabled: Boolean(moduleRow?.enabled), linked: Boolean((moduleRow?.config as { refreshToken?: string } | undefined)?.refreshToken), scopes: gmailModule.scopes },
      keys: keysPresent(),
      providerChoice: providerReport(settings.provider),
    });
  });

  app.post("/api/settings", async (c) => {
    const userId = c.get("userId");
    const body = z.object({
      provider: z.enum(["mock", "anthropic", "gemini"]).optional(),
      cheapModel: z.string().min(1).optional(),
      strongModel: z.string().min(1).optional(),
      judgeModel: z.string().min(1).optional(),
      alternateModel: z.string().min(1).optional(),
      localCategories: z.array(z.string()).optional(),
      forNowTtlHours: z.number().positive().max(24 * 30).optional(),
      dictationLang: z.string().optional(),
      usdToEur: z.number().positive().optional(),
      monthlyCapEur: z.number().positive().optional(),
      priceOverrides: z.record(z.object({ inputPerMTokUsd: z.number().nonnegative(), outputPerMTokUsd: z.number().nonnegative() })).optional(),
    }).parse(await c.req.json());
    const current = await getSettings(db, userId);
    const saved = await updateSettings(db, { ...current, ...body, userId });
    if (body.monthlyCapEur != null) await setBudget(db, userId, Math.round(body.monthlyCapEur * 100));
    await logAction(db, userId, { what: "settings updated", why: "You changed how the system is configured.", source: "user", payload: { provider: saved.provider } });
    return c.json(saved);
  });

  app.get("/api/modules/gmail/auth-url", async (c) => {
    assertGmailReadOnly("list");
    const redirectUri = `${process.env.PUBLIC_URL ?? "http://127.0.0.1:43123"}/api/modules/gmail/callback`;
    try {
      const url = gmailAuthUrl({ redirectUri, state: c.get("userId") });
      return c.json({ url, scopes: gmailModule.scopes });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gmail is not configured.";
      return c.json({ error: message, scopes: gmailModule.scopes }, 400);
    }
  });

  app.get("/api/modules/gmail/callback", async (c) => {
    const scope = c.req.query("scope") ?? "";
    if (scope) assertGrantedScopes(scope);
    assertGmailReadOnly("list");
    const code = c.req.query("code");
    if (!code || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return c.json({ error: "Gmail linking needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. The module stays read-only." }, 400);
    }
    const redirectUri = `${process.env.PUBLIC_URL ?? "http://127.0.0.1:43123"}/api/modules/gmail/callback`;
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const json = (await response.json()) as { refresh_token?: string; error?: string; scope?: string };
    if (!response.ok) return c.json({ error: json.error || "Google refused the token exchange." }, 400);
    if (json.scope) assertGrantedScopes(json.scope);
    await upsertModule(db, c.get("userId"), "gmail", true, { refreshToken: json.refresh_token ?? null });
    await logAction(db, c.get("userId"), { what: "gmail linked", why: "Read-only scope only. The module cannot send.", source: "gmail", payload: { scopes: gmailModule.scopes } });
    return c.redirect("/settings?gmail=linked");
  });

  app.post("/api/modules/gmail", async (c) => {
    const body = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    const existing = await getModule(db, c.get("userId"), "gmail");
    await upsertModule(db, c.get("userId"), "gmail", body.enabled, existing?.config ?? {});
    return c.json({ enabled: body.enabled, scopes: gmailModule.scopes, readOnly: true });
  });

  app.get("/api/modules/gmail/messages", async (c) => {
    const moduleRow = await getModule(db, c.get("userId"), "gmail");
    const config = (moduleRow?.config ?? {}) as { refreshToken?: string };
    return c.json(await gmailModule.listRecent(config));
  });

  app.post("/api/ingest", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.parseBody();
    const file = body.file;
    if (!file || typeof file !== "object" || !("arrayBuffer" in file)) return c.json({ error: "Attach a PDF, Word, or text file." }, 400);
    const bytes = Buffer.from(await file.arrayBuffer());
    const extracted = await textFromUpload(file.name || "upload", bytes);
    if (!extracted.text) return c.json({ error: "No text came out of that file." }, 422);
    const sourceId = await insertSource(db, userId, {
      title: file.name || "Upload",
      kind: extracted.kind,
      rawText: extracted.text,
      excerpt: extracted.text.slice(0, 400),
      origin: "ingest",
    });
    const ingestSettings = await getSettings(db, userId);
    const note = await insertNote(db, userId, {
      folderId: await ensureFolderPath(db, userId, "Inbox"),
      type: "file",
      title: file.name || "Upload",
      body: extracted.text.slice(0, 8000),
      status: "unexplored",
      forNowExpiresAt: null,
      mockEra: ingestSettings.provider === "mock",
      reason: "Imported. Stored in full as a source, with no quality gate.",
      causingMessageId: null,
      source: "ingest",
    });
    return c.json({ sourceId, note });
  });

  app.post("/api/sources", async (c) => {
    const body = z.object({ title: z.string().min(1), url: z.string().optional(), excerpt: z.string().optional() }).parse(await c.req.json());
    const sourceId = await insertSource(db, c.get("userId"), { ...body, kind: "bookmark", origin: "user" });
    return c.json({ id: sourceId });
  });

  app.get("/api/sources", async (c) => c.json(await listSources(db, c.get("userId"))));

  app.post("/api/jobs/nightly", async (c) => {
    const settings = await getSettings(db, c.get("userId"));
    return c.json(await runNightly(db, aiFor(settings), c.get("userId")));
  });

  app.post("/api/jobs/reflection", async (c) => {
    const settings = await getSettings(db, c.get("userId"));
    return c.json(await runReflection(db, aiFor(settings), c.get("userId"), { cause: "You asked reflection to run." }));
  });

  app.get("/api/jobs", async (c) => c.json(await listJobs(db, c.get("userId"))));

  app.get("/api/export", async (c) => {
    const userId = c.get("userId");
    const [soul, notes, folders, sources, debates, actions, picture, preferences, feedback, predictions, events] = await Promise.all([
      listSoulVersions(db, userId),
      listNotes(db, userId),
      listFolders(db, userId),
      listSources(db, userId),
      listDebates(db, userId),
      listActions(db, userId, 1000),
      listPicture(db, userId),
      listPreferences(db, userId),
      listFeedback(db, userId),
      listPredictions(db, userId),
      listEvents(db, userId, "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z"),
    ]);
    return c.json({ soul, notes, folders, sources, debates, actions, picture, preferences, feedback, predictions, events, usage: await listUsage(db, userId, "2000-01-01T00:00:00.000Z"), outreach: await listOutreach(db, userId) });
  });

  return app;
}
