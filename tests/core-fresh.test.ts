import { describe, expect, it } from "vitest";
import { createDb, migrate } from "../src/db.js";
import { migrateCore } from "../src/core/schema.js";
import { freshStartOnce, undoFreshStart } from "../src/core/fresh.js";

describe("the fresh start (archive, never delete)", () => {
  it("archives the old web once, keeps the calendar, and can be undone exactly", async () => {
    const db = await createDb({ memory: true });
    await migrate(db);
    await migrateCore(db);
    await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ('u','u@x','U','h')`);
    await db.query(`INSERT INTO bricks (id, user_id, name) VALUES ('old1','u','an old brick')`);
    await db.query(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, why, source) VALUES ('c1','u','meeting',now(),now(),'x','his')`);
    const first = await freshStartOnce(db);
    expect(first.done).toBe(true);
    expect(first.tables.bricks).toBe(1);
    expect((await freshStartOnce(db)).done).toBe(false);
    expect((await db.query(`SELECT archived_at FROM bricks WHERE id='old1'`)).rows[0].archived_at).not.toBeNull();
    expect((await db.query(`SELECT archived_at FROM calendar_events WHERE id='c1'`)).rows[0].archived_at).toBeNull();
    expect((await db.query(`SELECT count(*)::int AS n FROM bricks`)).rows[0].n).toBe(1);
    await undoFreshStart(db);
    expect((await db.query(`SELECT archived_at FROM bricks WHERE id='old1'`)).rows[0].archived_at).toBeNull();
    expect((await freshStartOnce(db)).done).toBe(false);
    await db.close();
  });
});
