import { afterEach, describe, expect, it } from "vitest";
import { createDb, migrate } from "../src/db.js";
import { insertNote, listUsers } from "../src/repo.js";
import { ensureUser } from "../src/seed.js";
import { createApp } from "../server/app.js";

const ENV_KEYS = ["USER_EMAIL", "USER_PASSWORD", "USER_NAME"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] == null) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function clearAccountEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

async function login(app: ReturnType<typeof createApp>, email: string, password: string): Promise<Response> {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

describe("account credentials", () => {
  it("rewrites the single account from USER_EMAIL and USER_PASSWORD and keeps its notes", async () => {
    clearAccountEnv();
    const db = await createDb({ memory: true });
    await migrate(db);
    const created = await ensureUser(db);
    const note = await insertNote(db, created.id, {
      folderId: null,
      type: "idea",
      title: "Keep this",
      body: "Still mine after the email changes.",
      status: "unexplored",
      forNowExpiresAt: null,
      reason: "Written before the Render password existed.",
      causingMessageId: null,
      source: "user",
    });

    process.env.USER_EMAIL = "Ada@Example.com";
    process.env.USER_PASSWORD = "from-render";
    process.env.USER_NAME = "Ada";
    const aligned = await ensureUser(db);

    const users = await listUsers(db);
    expect(users).toHaveLength(1);
    expect(aligned.id).toBe(created.id);
    expect(aligned.email).toBe("ada@example.com");
    expect(aligned.name).toBe("Ada");
    const stillThere = await db.query(`SELECT user_id, title FROM notes WHERE id = $1`, [note.id]);
    expect(stillThere.rows[0]).toMatchObject({ user_id: created.id, title: "Keep this" });

    const app = createApp(db);
    expect((await login(app, "ada@example.com", "from-render")).status).toBe(200);
    expect((await login(app, "peter@local", "hub-of-me")).status).toBe(401);
    expect((await login(app, "ada@example.com", "hub-of-me")).status).toBe(401);

    delete process.env.USER_NAME;
    const renamed = await ensureUser(db);
    expect(renamed.id).toBe(created.id);
    expect(renamed.name).toBe("Ada");
    await db.close();
  });

  it("leaves a Settings password in place until USER_PASSWORD is set again", async () => {
    clearAccountEnv();
    const db = await createDb({ memory: true });
    await migrate(db);
    await ensureUser(db);
    const app = createApp(db);
    const first = await login(app, "peter@local", "hub-of-me");
    expect(first.status).toBe(200);
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];

    const wrong = await app.request("/api/auth/password", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "not-it", newPassword: "replacement-1" }),
    });
    expect(wrong.status).toBe(401);

    const short = await app.request("/api/auth/password", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "hub-of-me", newPassword: "short" }),
    });
    expect(short.status).toBe(422);

    const changed = await app.request("/api/auth/password", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "hub-of-me", newPassword: "replacement-1" }),
    });
    expect(changed.status).toBe(200);
    expect((await login(app, "peter@local", "hub-of-me")).status).toBe(401);
    expect((await login(app, "peter@local", "replacement-1")).status).toBe(200);

    const afterRestart = await ensureUser(db);
    expect(await listUsers(db)).toHaveLength(1);
    expect(afterRestart.email).toBe("peter@local");
    expect((await login(app, "peter@local", "replacement-1")).status).toBe(200);

    process.env.USER_EMAIL = "peter@local";
    process.env.USER_PASSWORD = "from-render";
    await ensureUser(db);
    expect(await listUsers(db)).toHaveLength(1);
    expect(afterRestart.id).toBe((await listUsers(db))[0].id);
    expect((await login(app, "peter@local", "replacement-1")).status).toBe(401);
    expect((await login(app, "peter@local", "from-render")).status).toBe(200);
    await db.close();
  });
});
