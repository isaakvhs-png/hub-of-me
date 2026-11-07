import type { Db } from "../db.js";
import { getMeta, setMeta } from "./store.js";

/**
 * The rebuild's fresh start (BUILD_SPEC §11): archive the old web by setting archived_at, once. Kept: calendar, users,
 * sessions, settings, the soul (only its Nature lines and boundaries are read now). Nothing is deleted.
 * Undo: `npx tsx scripts/fresh-start.ts --undo` clears archived_at on exactly the rows this archived (same timestamp).
 */
export const OLD_WEB_TABLES = [
  "bricks", "sources", "brick_entries", "brick_links", "brick_moments", "agenda", "brain_sessions", "brain_stream", "brain_sources",
  "brain_activations", "mind_runs", "conversations", "notes", "tasks", "info_requests", "debates", "claims", "mind_notes", "jobs",
  "trace_events", "picture_statements", "discovery_cards", "outreach_requests", "briefs", "inner_versions",
];
const KEY = "fresh_start_rebuild";

async function hasArchivedAt(db: Db, table: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='archived_at'`, [table]);
  return r.rows.length > 0;
}

export async function freshStartOnce(db: Db, now = new Date()): Promise<{ done: boolean; at: string; tables: Record<string, number> }> {
  const prior = await getMeta({ db }, KEY);
  if (prior) return { done: false, at: prior, tables: {} };
  const at = now.toISOString();
  const tables: Record<string, number> = {};
  for (const table of OLD_WEB_TABLES) {
    if (!(await hasArchivedAt(db, table))) continue;
    const r = await db.query(`UPDATE ${table} SET archived_at=$1 WHERE archived_at IS NULL RETURNING 1`, [at]);
    tables[table] = r.rows.length;
  }
  await setMeta({ db }, KEY, at);
  return { done: true, at, tables };
}

export async function undoFreshStart(db: Db): Promise<Record<string, number>> {
  const at = await getMeta({ db }, KEY);
  if (!at || at.startsWith("undone")) return {};
  const tables: Record<string, number> = {};
  for (const table of OLD_WEB_TABLES) {
    if (!(await hasArchivedAt(db, table))) continue;
    const r = await db.query(`UPDATE ${table} SET archived_at=NULL WHERE archived_at=$1 RETURNING 1`, [at]);
    tables[table] = r.rows.length;
  }
  await setMeta({ db }, KEY, `undone:${at}`); // so the next start does not archive again
  return tables;
}
