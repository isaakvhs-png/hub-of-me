import { describe, expect, it } from "vitest";
import { createDb, migrate } from "../src/db.js";
import { ensureUser } from "../src/seed.js";
import { createApp } from "../server/app.js";

describe("diagnostics: everything", () => {
  it("shows every table read-only, without sessions or hashes", async () => {
    process.env.DIAGNOSTICS_TOKEN = "diag-everything-token";
    const db = await createDb({ memory: true });
    await migrate(db);
    await ensureUser(db, { email: "isaak@local", password: "secret-pass", name: "Isaak", provider: "mock" });
    const app = createApp(db);
    const res = await app.request("/api/diag/everything", { headers: { authorization: "Bearer diag-everything-token" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tables: Record<string, Record<string, unknown>[]> };
    expect(Object.keys(body.tables)).toEqual(expect.arrayContaining(["notes", "messages", "soul_versions", "thinking_sessions", "usage_records"]));
    expect(body.tables.sessions).toBeUndefined();
    expect(body.tables.users[0].password_hash).toBe("(hidden)");
    expect((await app.request("/api/diag/everything", { method: "POST", headers: { authorization: "Bearer diag-everything-token" } })).status).toBe(405);
    delete process.env.DIAGNOSTICS_TOKEN;
  });
});
