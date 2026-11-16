import { db } from "./state.js";
import { ensureLife } from "./web.js";

/**
 * Once (Isaak, 16 Nov): wipe the web and place everything again, in the order it came in. The sources (his messages,
 * files, its replies) stay; only the summaries and what feeds them go. Runs on the first start after this deploy.
 */
const KEY = "rewipe:2026-11-16";

export async function rewipeOnce(): Promise<boolean> {
  const done = await db().query(`SELECT 1 FROM meta WHERE key = $1`, [KEY]);
  if (done.rows.length) return false;
  await db().query(`DELETE FROM feeds`);
  await db().query(`DELETE FROM summary_versions`);
  await db().query(`DELETE FROM summaries`);
  await db().query(`UPDATE sources SET placed = false`);
  await db().query(`UPDATE projects SET summary_id = NULL`);
  await db().query(`INSERT INTO meta (key, value) VALUES ($1, $2)`, [KEY, new Date().toISOString()]);
  await ensureLife();
  return true;
}
