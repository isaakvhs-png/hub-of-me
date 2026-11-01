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