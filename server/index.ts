import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { loadEnv } from "./env.js";

loadEnv();
const { serve } = await import("@hono/node-server");
const { createDb, migrate } = await import("../src/db.js");
const { setDb } = await import("../src/state.js");
const { boot } = await import("../src/boot.js");
const { createApp } = await import("./app.js");

const port = Number(process.env.PORT ?? process.env.HUB_PORT ?? (process.env.NODE_ENV === "production" ? 43123 : 43124));
const database = await createDb();
await migrate(database);
setDb(database);
const stop = await boot();
const app = createApp();

const dist = join(process.cwd(), "client", "dist");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
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
    const cache = /[\\/]assets[\\/]/.test(target) ? "public, max-age=31536000, immutable" : "no-cache";
    return c.body(new Uint8Array(readFileSync(target)), 200, { "content-type": types[ext] ?? "application/octet-stream", "cache-control": cache });
  });
}

process.on("uncaughtException", (error) => console.error("uncaught:", error));
process.on("unhandledRejection", (reason) => console.error("unhandled:", reason));

const server = serve({ fetch: app.fetch, port }, () => console.log(`hub-rings on http://127.0.0.1:${port}`));
// A restart (Isaak, 16 Nov: "that big circle spins in the middle, like do not touch"): the screen shows it at once, new
// chat messages are refused, and an answer already under way gets up to 25 seconds to finish before the server goes.
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const { live, bump } = await import("../src/state.js");
  live.restarting = true; bump();
  const { chatIdle } = await import("../src/chat.js");
  await Promise.race([chatIdle(), new Promise((r) => setTimeout(r, 25_000))]);
  stop(); server.close(); void database.close().finally(() => process.exit(0));
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
