import { existsSync, readFileSync, statSync } from "node:fs";
import { loadEnv } from "./env.js";

loadEnv();
import { join, normalize } from "node:path";
import { serve } from "@hono/node-server";
import { createDb, migrate } from "../src/db.js";
import { MockProvider } from "../src/ai/mock.js";
import { Router } from "../src/ai/router.js";
import { runNightly } from "../src/pipeline/jobs.js";
import { scheduleFeedbackDrain } from "../src/feedback.js";
import { getSettings, settleStuckDebates } from "../src/repo.js";
import { applyEnvProvider, ensureUser } from "../src/seed.js";
import { ensureCuriosity, restoreCorruptedSouls } from "../src/soul.js";
import { freshStart } from "../src/fresh.js";
import { greetIfNeeded } from "../src/agent/turn.js";
import { zonedParts } from "../src/time.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? process.env.HUB_PORT ?? (process.env.NODE_ENV === "production" ? 43123 : 43124));
const db = await createDb();
await migrate(db);
await ensureUser(db);
await applyEnvProvider(db);
await settleStuckDebates(db);
await restoreCorruptedSouls(db);
await db.query(
  `UPDATE settings SET alternate_model = 'gemini:gemini-2.5-flash-lite' WHERE alternate_model LIKE '%gemini-2.5-flash' AND alternate_model NOT LIKE '%flash-lite%'`,
);
const fresh = await freshStart(db);
if (fresh) console.log(`Fresh start archived the previous center for ${fresh} account(s). Reason: Fresh start before core redesign.`);
await ensureCuriosity(db);
const everyone = await db.query<{ id: string }>(`SELECT id FROM users`);
for (const row of everyone.rows) {
  try {
    const settings = await getSettings(db, row.id);
    const ai = new Router(settings, { mock: settings.provider === "mock" ? new MockProvider() : undefined });
    await greetIfNeeded(db, ai, row.id);
  } catch (error) {
    console.error("greeting failed", error);
  }
}
await db.query(`UPDATE debate_feedback SET status = 'pending' WHERE status = 'running'`);
const queuedFeedback = await db.query<{ user_id: string }>(`SELECT DISTINCT user_id FROM debate_feedback WHERE status = 'pending'`);
for (const row of queuedFeedback.rows) {
  const userId = String(row.user_id);
  scheduleFeedbackDrain(db, userId, async () => {
    const settings = await getSettings(db, userId);
    return new Router(settings, { mock: settings.provider === "mock" ? new MockProvider() : undefined });
  });
}

const app = createApp(db);
const dist = join(process.cwd(), "client", "dist");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

if (process.env.NODE_ENV === "production") {
  app.get("*", async (c, next) => {
    if (c.req.path.startsWith("/api")) return next();
    const requested = normalize(c.req.path).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(dist, requested === "/" ? "index.html" : requested);
    const safe = filePath.startsWith(dist) && existsSync(filePath) && statSync(filePath).isFile();
    const target = safe ? filePath : join(dist, "index.html");
    if (!existsSync(target)) return c.text("Build the client first: npm run build", 500);
    const ext = target.slice(target.lastIndexOf("."));
    return c.body(new Uint8Array(readFileSync(target)), 200, { "content-type": types[ext] ?? "application/octet-stream" });
  });
}

let lastNight = "";
const timer = setInterval(() => {
  const parts = zonedParts(new Date(), "Europe/Amsterdam");
  const key = `${parts.year}-${parts.month}-${parts.day}`;
  if (parts.hour !== 3 || lastNight === key) return;
  lastNight = key;
  void runNightlyForEveryone();
}, 60_000);

async function runNightlyForEveryone(): Promise<void> {
  const users = await db.query<{ id: string }>(`SELECT id FROM users`);
  for (const row of users.rows) {
    try {
      const settings = await getSettings(db, row.id);
      const ai = new Router(settings, { mock: settings.provider === "mock" ? new MockProvider() : undefined });
      await runNightly(db, ai, row.id);
    } catch (error) {
      console.error("nightly failed", error);
    }
  }
}

serve({ fetch: app.fetch, port }, () => {
  console.log(`Hub of Me API on http://127.0.0.1:${port}`);
});

process.on("SIGTERM", () => {
  clearInterval(timer);
  void db.close();
});
