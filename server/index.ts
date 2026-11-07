import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { loadEnv } from "./env.js";

loadEnv();
const { serve } = await import("@hono/node-server");
const { createDb } = await import("../src/db.js");
const { bootCore, ctxFor } = await import("../src/core/index.js");
const { listUserIds } = await import("../src/core/accounts.js");
const { startClock } = await import("../src/core/rhythm.js");
const { createApp } = await import("./app.js");

const port = Number(process.env.PORT ?? process.env.HUB_PORT ?? (process.env.NODE_ENV === "production" ? 43123 : 43124));
const db = await createDb();
const { fresh } = await bootCore(db);
if (fresh.done) console.log(`Fresh start: the old web was archived at ${fresh.at}:`, fresh.tables);

const app = createApp(db);
const dist = join(process.cwd(), "client", "dist");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json", ".woff2": "font/woff2", ".ico": "image/x-icon",
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

// The clock: the rhythm every minute (heartbeat, filing, upkeep, own time, the 23:30 review) and the scheduler every 2 s.
const stop = startClock(async () => Promise.all((await listUserIds(db)).map((id) => ctxFor(db, id))), process.env.RENDER_GIT_COMMIT ?? "");

const server = serve({ fetch: app.fetch, port }, () => console.log(`Hub of Me on http://127.0.0.1:${port}`));
const shutdown = () => { stop(); server.close(); void db.close().finally(() => process.exit(0)); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
