import type { Db } from "./db.js";
import { getSoul, logAction, listUsers } from "./repo.js";
import { changeSoul } from "./soul.js";
import { SEED_SOUL } from "./soul-seed.js";

export const FRESH_REASON = "Fresh start before core redesign";

/** Archive the old center once. Rows stay. The account is not touched. */
export async function freshStart(db: Db): Promise<number> {
  const users = await listUsers(db);
  let started = 0;
  for (const user of users) {
    const already = await db.query(`SELECT user_id FROM fresh_starts WHERE user_id = $1`, [user.id]);
    if (already.rows[0]) continue;
    await db.query(`UPDATE notes SET status = 'archived', archived_at = COALESCE(archived_at, now()), updated_at = now() WHERE user_id = $1 AND status <> 'archived'`, [user.id]);
    await db.query(
      `UPDATE tasks SET status = 'archived', fade_reason = CASE WHEN fade_reason IS NULL OR fade_reason = '' THEN $2 ELSE fade_reason END, updated_at = now() WHERE user_id = $1 AND status <> 'archived'`,
      [user.id, FRESH_REASON],
    );
    await db.query(`UPDATE info_requests SET status = 'archived', updated_at = now() WHERE user_id = $1 AND status <> 'archived'`, [user.id]);
    await db.query(`UPDATE debates SET archived_at = COALESCE(archived_at, now()) WHERE user_id = $1`, [user.id]);
    await db.query(`UPDATE conversations SET archived_at = COALESCE(archived_at, now()) WHERE user_id = $1`, [user.id]);
    await db.query(`UPDATE claims SET archived_at = COALESCE(archived_at, now()) WHERE user_id = $1`, [user.id]);
    await db.query(`UPDATE mind_notes SET archived_at = COALESCE(archived_at, now()) WHERE user_id = $1`, [user.id]);
    await db.query(`UPDATE soul_versions SET archived_at = COALESCE(archived_at, now()) WHERE user_id = $1 AND version > 1`, [user.id]);
    const current = await getSoul(db, user.id);
    if (current?.reason !== FRESH_REASON) {
      await changeSoul(db, user.id, { content: SEED_SOUL, reason: FRESH_REASON, via: "fresh" });
    }
    await db.query(`INSERT INTO fresh_starts (user_id, reason) VALUES ($1, $2)`, [user.id, FRESH_REASON]);
    await logAction(db, user.id, { what: "fresh start", why: FRESH_REASON, source: "fresh", payload: {} });
    started += 1;
  }
  return started;
}
