import type { Db } from "./db.js";
import { getSoul, logAction, listUsers } from "./repo.js";
import { changeSoul } from "./soul.js";
import { SEED_SOUL } from "./soul-seed.js";

export const FRESH_REASON = "Fresh start for the playtest, round 10c (Opus pinned)";

/** Archive the old center once. Rows stay. The account is not touched. */
export async function freshStart(db: Db): Promise<number> {
  const users = await listUsers(db);
  let started = 0;
  for (const user of users) {
    const already = await db.query(`SELECT reason FROM fresh_starts WHERE user_id = $1`, [user.id]);
    // One fresh start per reason: a new reason (a new playtest) archives everything again. Rows stay; nothing is deleted.
    if (already.rows[0] && String(already.rows[0].reason) === FRESH_REASON) continue;
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
    await db.query(`UPDATE trace_events SET seen_at = COALESCE(seen_at, now()) WHERE user_id = $1`, [user.id]);
    // The calendar belongs to the round too: a fresh start must not hand it an old guess as a fact.
    await db.query(`UPDATE calendar_events SET archived_at = COALESCE(archived_at, now()) WHERE user_id = $1`, [user.id]);
    await db.query(`UPDATE inner_state SET thinking = '', curious = '', busy = '', waiting = '', next_wake_at = NULL, wake_why = '', life_map = '', portrait = '', self_portrait = '', intentions = '', self_looked_at = NULL, start_model = '', open_notes = '[]' WHERE user_id = $1`, [user.id]);
    const current = await getSoul(db, user.id);
    if (current?.reason !== FRESH_REASON) {
      await changeSoul(db, user.id, { content: SEED_SOUL, reason: FRESH_REASON, via: "fresh" });
    }
    await db.query(
      `INSERT INTO fresh_starts (user_id, reason) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason, greeted_at = NULL, created_at = now()`,
      [user.id, FRESH_REASON],
    );
    await logAction(db, user.id, { what: "fresh start", why: FRESH_REASON, source: "fresh", payload: {} });
    started += 1;
  }
  for (const user of users) await catchUpFreshStart(db, user.id);
  return started;
}

/** Archive anything older than the fresh-start marker that is still in the live chat. Safe to run every boot. */
export async function catchUpFreshStart(db: Db, userId: string): Promise<void> {
  const marker = await db.query(`SELECT created_at FROM fresh_starts WHERE user_id = $1`, [userId]);
  const at = marker.rows[0]?.created_at;
  if (!at) return;
  await db.query(
    `UPDATE conversations SET archived_at = COALESCE(archived_at, now()) WHERE user_id = $1 AND archived_at IS NULL AND created_at < $2`,
    [userId, at],
  );
  await db.query(
    `UPDATE notes SET status = 'archived', archived_at = COALESCE(archived_at, now()), updated_at = now() WHERE user_id = $1 AND status <> 'archived' AND created_at < $2`,
    [userId, at],
  );
  await db.query(
    `UPDATE tasks SET status = 'archived', fade_reason = CASE WHEN fade_reason IS NULL OR fade_reason = '' THEN $3 ELSE fade_reason END, updated_at = now() WHERE user_id = $1 AND status <> 'archived' AND created_at < $2`,
    [userId, at, FRESH_REASON],
  );
  await db.query(
    `UPDATE info_requests SET status = 'archived', updated_at = now() WHERE user_id = $1 AND status <> 'archived' AND created_at < $2`,
    [userId, at],
  );
  await db.query(
    `UPDATE debates SET archived_at = COALESCE(archived_at, now()) WHERE user_id = $1 AND archived_at IS NULL AND created_at < $2`,
    [userId, at],
  );
  await db.query(
    `UPDATE claims SET archived_at = COALESCE(archived_at, now()) WHERE user_id = $1 AND archived_at IS NULL AND created_at < $2`,
    [userId, at],
  );
  await db.query(
    `UPDATE mind_notes SET archived_at = COALESCE(archived_at, now()) WHERE user_id = $1 AND archived_at IS NULL AND created_at < $2`,
    [userId, at],
  );
  await db.query(
    `UPDATE calendar_events SET archived_at = COALESCE(archived_at, now()) WHERE user_id = $1 AND archived_at IS NULL AND created_at < $2`,
    [userId, at],
  );
  await db.query(
    `UPDATE jobs SET archived_at = COALESCE(archived_at, now()) WHERE user_id = $1 AND archived_at IS NULL AND started_at < $2`,
    [userId, at],
  );
  await db.query(
    `UPDATE soul_versions SET archived_at = COALESCE(archived_at, now()) WHERE user_id = $1 AND version > 1 AND archived_at IS NULL AND version < (SELECT MAX(version) FROM soul_versions WHERE user_id = $1)`,
    [userId],
  );
}
