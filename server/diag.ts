import { timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import type { Db } from "../src/db.js";
import { listUserIds } from "../src/core/accounts.js";
import { ctxFor } from "../src/core/index.js";
import { healthChecks } from "../src/core/health.js";
import { computeSignals } from "../src/core/mirror.js";
import { getRun, listRuns } from "../src/core/queue.js";
import { listStream } from "../src/core/store.js";
import { listProposals, listRequests } from "../src/core/workshop.js";
import { howYouWork } from "../src/self/how.js";
import { recentServerErrors } from "./error-log.js";

/**
 * Diagnostics for builders (BUILD_SPEC §10). GET /api/diag/* with Authorization: Bearer <DIAGNOSTICS_TOKEN>.
 * Unset token: the routes answer 404. Secrets are redacted from every answer.
 */
export const DIAG_ROUTES = ["/api/diag/runs", "/api/diag/runs/:id", "/api/diag/signals", "/api/diag/health", "/api/diag/requests", "/api/diag/brief", "/api/diag/stream", "/api/diag/errors"] as const;

export function bearerMatches(header: string | undefined, expected: string): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  const provided = Buffer.from(match?.[1] ?? "");
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length) { timingSafeEqual(wanted, wanted); return false; }
  return timingSafeEqual(provided, wanted);
}

export function redactSecrets<T>(value: T): T {
  const secrets = ["DATABASE_URL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GEMINI_API_KEY", "GOOGLE_API_KEY", "SESSION_SECRET", "DIAGNOSTICS_TOKEN", "USER_PASSWORD"]
    .map((n) => process.env[n]?.trim() ?? "").filter((v) => v.length >= 8).sort((a, b) => b.length - a.length);
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") { let t = input; for (const s of secrets) t = t.split(s).join("[redacted]"); return t; }
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object" && !(input instanceof Date)) return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, walk(v)]));
    return input;
  };
  return walk(value) as T;
}

export async function runRecord(db: Db, userId: string, runId: string) {
  const ctx = await ctxFor(db, userId);
  const run = await getRun(ctx, runId);
  if (!run) return null;
  const steps = (await db.query(`SELECT id, node, kind, label, model, ms, chars_in, chars_out, ok, detail, seq, at FROM run_steps WHERE user_id=$1 AND run_id=$2 ORDER BY seq, at`, [userId, runId])).rows
    .map((s) => ({ ...s, detail: JSON.parse(String(s.detail || "{}")) }));
  const pack = (await db.query(`SELECT contents, used FROM packs WHERE user_id=$1 AND run_id=$2`, [userId, runId])).rows.map((p) => ({ contents: JSON.parse(String(p.contents)), used: JSON.parse(String(p.used)) }));
  return { run, steps, packs: pack };
}

export function mountDiagnostics(app: Hono<{ Variables: { userId: string } }>, db: Db): void {
  app.use("/api/diag/*", async (c, next) => {
    const expected = process.env.DIAGNOSTICS_TOKEN?.trim();
    if (!expected) return c.json({ error: "Not found" }, 404);
    if (!bearerMatches(c.req.header("authorization"), expected)) return c.json({ error: "Unauthorized" }, 401);
    const ids = await listUserIds(db);
    if (ids.length !== 1) return c.json({ error: "Diagnostics expect exactly one account." }, 409);
    c.set("userId", ids[0]);
    await next();
  });
  const day = () => ({ from: new Date(Date.now() - 86_400_000), to: new Date() });
  app.get("/api/diag/runs", async (c) => c.json(redactSecrets(await listRuns(await ctxFor(db, c.get("userId")), { limit: Number(c.req.query("limit") ?? 50) }))));
  app.get("/api/diag/runs/:id", async (c) => {
    const record = await runRecord(db, c.get("userId"), c.req.param("id"));
    return record ? c.json(redactSecrets(record)) : c.json({ error: "No such run" }, 404);
  });
  app.get("/api/diag/signals", async (c) => {
    const days = Math.min(30, Math.max(1, Number(c.req.query("days") ?? 1)));
    const to = new Date();
    return c.json(redactSecrets(await computeSignals(await ctxFor(db, c.get("userId")), new Date(to.getTime() - days * 86_400_000), to)));
  });
  app.get("/api/diag/health", async (c) => c.json(redactSecrets(await healthChecks(await ctxFor(db, c.get("userId"))))));
  app.get("/api/diag/requests", async (c) => {
    const ctx = await ctxFor(db, c.get("userId"));
    return c.json(redactSecrets({ requests: await listRequests(ctx), proposals: await listProposals(ctx) }));
  });
  app.get("/api/diag/stream", async (c) => c.json(redactSecrets(await listStream(await ctxFor(db, c.get("userId")), Number(c.req.query("limit") ?? 100)))));
  app.get("/api/diag/errors", (c) => c.json(redactSecrets(recentServerErrors(100))));
  app.get("/api/diag/brief", async (c) => {
    const ctx = await ctxFor(db, c.get("userId"));
    const to = new Date();
    const week = await computeSignals(ctx, new Date(to.getTime() - 7 * 86_400_000), to);
    const { from } = day();
    const today = await computeSignals(ctx, from, to);
    const health = await healthChecks(ctx);
    const brief = [
      "# Builder brief (generated)",
      "", "## Health checks", ...health.map((h) => `- ${h.ok ? "ok" : "NOT OK"} ${h.name}: ${h.detail}`),
      "", "## Signals, last 24 hours", "```json", JSON.stringify(today, null, 1), "```",
      "", "## Signals, last 7 days", "```json", JSON.stringify(week, null, 1), "```",
      "", "## Open requests", ...(await listRequests(ctx, { open: true })).map((r) => `- ${r.id} ${r.title} (${r.status}, ${r.evidenceCount} runs)`),
      "", howYouWork(),
    ].join("\n");
    return c.text(redactSecrets(brief));
  });
}
