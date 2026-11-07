import { describe, expect, it } from "vitest";
import { createDb, migrate } from "../src/db.js";
import { ensureUser } from "../src/seed.js";
import { createApp } from "../server/app.js";

describe("http boundaries", () => {
  it("logs in, archives, and has no delete route", async () => {
    const db = await createDb({ memory: true });
    await migrate(db);
    await ensureUser(db, { email: "peter@local", password: "hub-of-me", name: "Peter", provider: "mock" });
    const app = createApp(db);
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "peter@local", password: "hub-of-me" }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const removed = await app.request("/api/notes/missing", { method: "DELETE", headers: { cookie } });
    expect(removed.status).toBe(404);
    const send = await app.request("/api/modules/gmail/send", { method: "POST", headers: { cookie } });
    expect(send.status).toBe(404);
    const me = await app.request("/api/auth/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    await db.close();
  });
});
