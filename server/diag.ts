import { timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import type { Db } from "../src/db.js";
import { providerReport, resolveRoleModel } from "../src/ai/router.js";
import { healthReport } from "../src/health.js";
import {
  getSettings,
  getSoul,
  listActions,
  listDebateSides,
  listDebates,
  listJobs,
  listSoulVersions,
  listUsage,
  listUsers,
} from "../src/repo.js";
import type { UsageRow } from "../src/types.js";
import { recentServerErrors } from "./error-log.js";

export const DIAG_ROUTES = [
  "/api/diag/config",
  "/api/diag/health",
  "/api/diag/recent",
  "/api/diag/debates",
  "/api/diag/soul",
  "/api/diag/errors",
] as const;

function diagnosticsToken(): string | null {
  const value = process.env.DIAGNOSTICS_TOKEN?.trim();
  return value ? value : null;
}

/** Constant-time bearer check. A length mismatch still compares the expected token. */
export function bearerMatches(header: string | undefined, expected: string): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  const provided = Buffer.from(match?.[1] ?? "");
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length) {
    timingSafeEqual(wanted, wanted);
    return false;
  }
  return timingSafeEqual(provided, wanted);
}

function secretValues(): string[] {
  const names = [
    "DATABASE_URL",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "SESSION_SECRET",
    "DIAGNOSTICS_TOKEN",
    "USER_PASSWORD",
    "GOOGLE_CLIENT_SECRET",
  ];
  return names
    .map((name) => process.env[name]?.trim() ?? "")
    .filter((value) => value.length >= 8)
    .sort((a, b) => b.length - a.length);
}

export function redactSecrets<T>(value: T): T {
  const secrets = secretValues();
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") {
      let text = input;
      for (const secret of secrets) text = text.split(secret).join("[redacted]");
      return text;
    }
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, walk(item)]));
    }
    return input;
  };
  return walk(value) as T;
}

function isoTime(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function includeArchived(c: Context): boolean {
  return c.req.query("includeArchived") === "1";
}

function limitOf(c: Context): number {
  const raw = Number(c.req.query("limit") ?? 20);
  if (!Number.isFinite(raw)) return 20;
  return Math.min(100, Math.max(1, Math.floor(raw)));
}

async function soleUserId(db: Db): Promise<string | null> {
  const users = await listUsers(db);
  return users.length === 1 ? users[0].id : null;
}

function groupUsage(rows: UsageRow[], keyOf: (row: UsageRow) => { key: string; provider: string; model: string }) {
  const map = new Map<string, { key: string; provider: string; model: string; calls: number; inputTokens: number; outputTokens: number; costEurCents: number }>();
  for (const row of rows) {
    const parts = keyOf(row);
    const id = `${parts.key}\0${parts.provider}\0${parts.model}`;
    const current = map.get(id) ?? { ...parts, calls: 0, inputTokens: 0, outputTokens: 0, costEurCents: 0 };
    current.calls += 1;
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.costEurCents += row.costEurCents ?? 0;
    map.set(id, current);
  }
  return [...map.values()];
}

function callView(row: UsageRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    role: row.role,
    provider: row.provider,
    model: row.model,
    conversationId: row.conversationId,
    jobId: row.jobId,
    jobKind: row.jobKind,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costEurCents: row.costEurCents,
    priceKnown: row.priceKnown,
    error: null as string | null,
    mock: row.provider === "mock",
  };
}

export function mountDiagnostics(app: Hono<{ Variables: { userId: string } }>, db: Db): void {
  app.use("/api/diag/*", async (c, next) => {
    const expected = diagnosticsToken();
    if (!expected) return c.json({ error: "Not found." }, 404);
    if (c.req.method !== "GET") return c.json({ error: "Diagnostics are read-only." }, 405);
    if (!bearerMatches(c.req.header("authorization"), expected)) return c.json({ error: "Unauthorized." }, 401);
    await next();
  });

  app.get("/api/diag/config", async (c) => {
    const userId = await soleUserId(db);
    if (!userId) return c.json(redactSecrets({ account: null, provider: providerReport("mock"), models: null }));
    const settings = await getSettings(db, userId);
    const report = providerReport(settings.provider);
    const models = {
      conversation: resolveRoleModel(settings, { role: "conversation" }),
      critic: resolveRoleModel(settings, { role: "critic" }),
      judge: resolveRoleModel(settings, { role: "judge" }),
      debater0: resolveRoleModel(settings, { role: "debater", debaterIndex: 0 }),
      debater1: resolveRoleModel(settings, { role: "debater", debaterIndex: 1 }),
    };
    return c.json(redactSecrets({ account: userId, provider: report, models, settingsProvider: settings.provider }));
  });

  app.get("/api/diag/health", async (c) => {
    const userId = await soleUserId(db);
    if (!userId) return c.json(redactSecrets({ account: null, calls: [], byDay: [], byConversation: [], byJob: [] }));
    const report = await healthReport(db, userId);
    const since = report.monthStart;
    const usage = await listUsage(db, userId, since);
    const dayKey = (isoDate: string) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(isoDate));
    return c.json(
      redactSecrets({
        account: userId,
        monthStart: since,
        capEurCents: report.capEurCents,
        spentEurCents: report.spentEurCents,
        calls: usage.map(callView),
        byDay: groupUsage(usage, (row) => ({ key: dayKey(row.createdAt), provider: row.provider, model: row.model })),
        byConversation: groupUsage(usage, (row) => ({ key: row.conversationId ?? "(no conversation)", provider: row.provider, model: row.model })),
        byJob: groupUsage(usage, (row) => ({ key: row.jobId ?? row.jobKind ?? row.role, provider: row.provider, model: row.model })),
      }),
    );
  });

  app.get("/api/diag/recent", async (c) => {
    const limit = limitOf(c);
    const archived = includeArchived(c);
    const userId = await soleUserId(db);
    if (!userId) return c.json(redactSecrets({ limit, dumps: [], notes: [], calls: [], failures: [] }));
    const [dumps, notes, usage, jobs, actions] = await Promise.all([
      db.query(
        `SELECT m.id, m.conversation_id, m.content, m.created_at
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.user_id = $1 AND m.role = 'user' AND ($3::boolean OR c.archived_at IS NULL)
         ORDER BY m.created_at DESC
         LIMIT $2`,
        [userId, limit, archived],
      ),
      db.query(
        `SELECT id, type, title, body, status, mock_era, created_at FROM notes WHERE user_id = $1 AND ($3::boolean OR status <> 'archived') ORDER BY created_at DESC LIMIT $2`,
        [userId, limit, archived],
      ),
      listUsage(db, userId, "1970-01-01T00:00:00.000Z"),
      listJobs(db, userId),
      listActions(db, userId, limit),
    ]);
    const visibleJobs = archived ? jobs : jobs.filter((job) => !job.archivedAt);
    const failures = [
      ...visibleJobs
        .filter((job) => String(job.status) === "failed" || String(job.status) === "refused")
        .map((job) => ({ at: String(job.finishedAt ?? job.startedAt), what: `${String(job.kind)} ${String(job.status)}`, why: String(job.report), source: "job" })),
      ...actions
        .filter((action) => /fail|stopped|error|refused/i.test(String(action.what)))
        .map((action) => ({ at: String(action.createdAt), what: String(action.what), why: String(action.why), source: String(action.source) })),
    ].slice(0, limit);
    return c.json(
      redactSecrets({
        limit,
        dumps: dumps.rows.map((row) => ({
          id: String(row.id),
          conversationId: String(row.conversation_id),
          content: String(row.content),
          createdAt: isoTime(row.created_at),
        })),
        notes: notes.rows.map((row) => ({
          id: String(row.id),
          type: String(row.type),
          title: String(row.title),
          body: String(row.body),
          status: String(row.status),
          mockEra: row.mock_era === true || row.mock_era === "t",
          createdAt: isoTime(row.created_at),
        })),
        calls: usage.slice(-limit).reverse().map(callView),
        failures,
      }),
    );
  });

  app.get("/api/diag/debates", async (c) => {
    const limit = limitOf(c);
    const userId = await soleUserId(db);
    if (!userId) return c.json(redactSecrets({ debates: [] }));
    const archived = includeArchived(c);
    const debates = (await listDebates(db, userId, true)).filter((debate) => archived || !debate.archivedAt).slice(0, limit);
    const withSides = await Promise.all(
      debates.map(async (debate) => ({
        ...debate,
        sides: await listDebateSides(db, String(debate.id)),
      })),
    );
    return c.json(redactSecrets({ debates: withSides }));
  });

  app.get("/api/diag/soul", async (c) => {
    const userId = await soleUserId(db);
    if (!userId) return c.json(redactSecrets({ current: null, versions: [] }));
    const [current, versions] = await Promise.all([getSoul(db, userId), listSoulVersions(db, userId)]);
    return c.json(redactSecrets({ current, versions }));
  });

  app.get("/api/diag/errors", async (c) => {
    const limit = limitOf(c);
    const archived = includeArchived(c);
    const userId = await soleUserId(db);
    const jobs = userId ? await listJobs(db, userId) : [];
    const actions = userId ? await listActions(db, userId, 200) : [];
    const marker = userId ? await db.query(`SELECT created_at FROM fresh_starts WHERE user_id = $1`, [userId]) : { rows: [] };
    const mark = marker.rows[0]?.created_at ? new Date(String(marker.rows[0].created_at)).getTime() : null;
    const afterMarker = (at: string) => archived || mark == null || new Date(at).getTime() >= mark;
    return c.json(
      redactSecrets({
        server: recentServerErrors(limit),
        jobs: jobs
          .filter((job) => (archived || !job.archivedAt) && (String(job.status) === "failed" || String(job.status) === "refused"))
          .slice(0, limit),
        actions: actions
          .filter((action) => /fail|stopped|error|refused/i.test(String(action.what)) && afterMarker(String(action.createdAt)))
          .slice(0, limit),
      }),
    );
  });
}
