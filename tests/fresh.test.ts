import { describe, expect, it } from "vitest";
import { freshStart, FRESH_REASON } from "../src/fresh.js";
import { getSoul, insertUsage, listNotes, listTasks } from "../src/repo.js";
import { rememberTasks } from "../src/tasks.js";
import { fresh } from "./helpers.js";

describe("fresh start", () => {
  it("archives the old center once and leaves usage and the account", async () => {
    const { db, user } = await fresh();
    await rememberTasks(db, user.id, [{ title: "summary of orchard", why: "Still open.", owner: "peter" }], { sourceKind: "dump" });
    await db.query(`INSERT INTO notes (id, user_id, type, title, body, status, current_version) VALUES ('note-1', $1, 'idea', 'Old', 'A dump.', 'unexplored', 1)`, [user.id]);
    await insertUsage(db, {
      userId: user.id,
      role: "conversation",
      provider: "mock",
      model: "mock-cheap",
      inputTokens: 10,
      outputTokens: 4,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      costUsdCents: 0,
      costEurCents: 0,
      priceKnown: true,
      durationMs: 1,
      inputChars: 3,
      outputText: "kept",
      conversationId: null,
      jobId: null,
      jobKind: null,
    });
    expect(await freshStart(db)).toBe(1);
    expect(await freshStart(db)).toBe(0);
    const old = await db.query(
      `INSERT INTO conversations (id, user_id, title, created_at) VALUES ('old-chat', $1, 'Old dump', $2) RETURNING id`,
      [user.id, "2020-01-01T00:00:00.000Z"],
    );
    expect(old.rows[0]?.id).toBe("old-chat");
    const { catchUpFreshStart } = await import("../src/fresh.js");
    await catchUpFreshStart(db, user.id);
    const archived = await db.query(`SELECT archived_at FROM conversations WHERE id = 'old-chat'`);
    expect(archived.rows[0]?.archived_at).toBeTruthy();
    const live = await db.query(
      `INSERT INTO conversations (id, user_id, title) VALUES ('new-chat', $1, 'Hello') RETURNING archived_at`,
      [user.id],
    );
    await catchUpFreshStart(db, user.id);
    const still = await db.query(`SELECT archived_at FROM conversations WHERE id = 'new-chat'`);
    expect(still.rows[0]?.archived_at ?? null).toBeNull();
    expect(live.rows[0]?.archived_at ?? null).toBeNull();
    const soul = await getSoul(db, user.id);
    expect(soul?.reason).toBe(FRESH_REASON);
    expect(soul?.content).toMatch(/## Purpose/);
    expect((await listNotes(db, user.id)).every((note) => note.status === "archived")).toBe(true);
    expect(await listTasks(db, user.id, "open")).toHaveLength(0);
    expect((await listTasks(db, user.id)).some((task) => task.status === "archived")).toBe(true);
    const usage = await db.query(`SELECT COUNT(*) AS n FROM usage_records WHERE user_id = $1`, [user.id]);
    expect(Number(usage.rows[0]?.n)).toBe(1);
    const account = await db.query(`SELECT email FROM users WHERE id = $1`, [user.id]);
    expect(account.rows[0]?.email).toBe("peter@test");
    await db.close();
  });
});
describe("a second fresh start", () => {
  it("runs again when the reason changes, and archives without deleting", async () => {
    const { db, user } = await fresh();
    const { freshStart, FRESH_REASON } = await import("../src/fresh.js");
    await db.query(`INSERT INTO fresh_starts (user_id, reason, greeted_at) VALUES ($1, 'Fresh start before core redesign', now())`, [user.id]);
    await db.query(`INSERT INTO notes (id, user_id, type, title, body, status, current_version) VALUES ('n-live', $1, 'idea', 'Live', 'Kept.', 'unexplored', 1)`, [user.id]);
    expect(await freshStart(db)).toBe(1);
    const marker = (await db.query(`SELECT reason, greeted_at FROM fresh_starts WHERE user_id = $1`, [user.id])).rows[0];
    expect(marker.reason).toBe(FRESH_REASON);
    expect(marker.greeted_at).toBeNull();
    const note = (await db.query(`SELECT status FROM notes WHERE id = 'n-live'`)).rows[0];
    expect(note.status).toBe("archived");
  });
});
