import { afterEach, describe, expect, it } from "vitest";
import { createDb, migrate } from "../src/db.js";
import { insertNote } from "../src/repo.js";
import { ensureUser } from "../src/seed.js";
import { createApp } from "../server/app.js";
import { DIAG_ROUTES } from "../server/diag.js";
import { recordServerError } from "../server/error-log.js";

const ENV = ["DIAGNOSTICS_TOKEN", "ANTHROPIC_API_KEY", "DATABASE_URL", "AI_PROVIDER"] as const;
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] == null) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const TOKEN = "diag-token-test-value";
const KEY = "sk-ant-test-secret-value";
const DATABASE = "postgres://user:super-secret@example.com/hub";

describe("diagnostics", () => {
  it("rejects non-GET and missing or wrong tokens, and stays hidden when unset", async () => {
    delete process.env.DIAGNOSTICS_TOKEN;
    const db = await createDb({ memory: true });
    await migrate(db);
    await ensureUser(db, { email: "peter@local", password: "hub-of-me", name: "Peter", provider: "mock" });
    const hidden = createApp(db);
    for (const path of DIAG_ROUTES) {
      expect((await hidden.request(path)).status, path).toBe(404);
      expect((await hidden.request(path, { method: "POST" })).status, path).toBe(404);
    }

    process.env.DIAGNOSTICS_TOKEN = TOKEN;
    process.env.ANTHROPIC_API_KEY = KEY;
    process.env.DATABASE_URL = DATABASE;
    process.env.AI_PROVIDER = "anthropic";
    const app = createApp(db);
    const methods = ["POST", "PUT", "PATCH", "DELETE"] as const;
    for (const path of DIAG_ROUTES) {
      for (const method of methods) {
        const denied = await app.request(path, { method, headers: { authorization: `Bearer ${TOKEN}` } });
        expect(denied.status, `${method} ${path}`).toBe(405);
      }
      expect((await app.request(path)).status, path).toBe(401);
      expect((await app.request(path, { headers: { authorization: "Bearer wrong-token" } })).status, path).toBe(401);
      expect((await app.request(path, { headers: { authorization: `Bearer ${TOKEN} ` } })).status, path).toBe(200);
    }

    await insertNote(db, (await ensureUser(db, { email: "peter@local", password: "hub-of-me", name: "Peter", provider: "mock" })).id, {
      folderId: null,
      type: "idea",
      title: "Contains a secret",
      body: `Do not echo ${KEY} or ${DATABASE}.`,
      status: "unexplored",
      forNowExpiresAt: null,
      reason: "Diagnostics redaction.",
      causingMessageId: null,
      source: "user",
    });
    recordServerError({ at: new Date().toISOString(), method: "POST", path: "/api/dump", status: 500, message: `Anthropic failed near ${KEY}` });

    const config = await app.request("/api/diag/config", { headers: { authorization: `Bearer ${TOKEN}` } });
    const configBody = await config.json();
    expect(configBody.provider.active).toBe("mock");
    expect(configBody.provider.envNormalized).toBe("anthropic");
    expect(configBody.provider.keys).toEqual({ anthropic: true, gemini: false });
    expect(configBody.models.conversation.provider).toBe("mock");

    const recent = await (await app.request("/api/diag/recent", { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    const errors = await (await app.request("/api/diag/errors", { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    const blob = JSON.stringify({ configBody, recent, errors });
    expect(blob).not.toContain(KEY);
    expect(blob).not.toContain(DATABASE);
    expect(blob).not.toContain(TOKEN);
    expect(blob).toContain("[redacted]");
    expect(recent.notes[0].title).toBe("Contains a secret");
    const userId = (await ensureUser(db, { email: "peter@local", password: "hub-of-me", name: "Peter", provider: "mock" })).id;
    await db.query(`UPDATE notes SET status = 'archived' WHERE user_id = $1`, [userId]);
    const withoutArchive = await (await app.request("/api/diag/recent", { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    expect(withoutArchive.notes).toHaveLength(0);
    const shown = await (await app.request("/api/diag/recent?includeArchived=1", { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    expect(shown.notes[0].title).toBe("Contains a secret");
    expect(errors.server[0].path).toBe("/api/dump");

    const health = await (await app.request("/api/diag/health", { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    expect(health.calls).toEqual([]);
    expect(health.byDay).toEqual([]);
    const soul = await (await app.request("/api/diag/soul", { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    expect(soul.current.content).toBeTruthy();
    expect(soul.versions.length).toBeGreaterThan(0);
    const debates = await (await app.request("/api/diag/debates", { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    expect(debates.debates).toEqual([]);
    await db.close();
  });
});
