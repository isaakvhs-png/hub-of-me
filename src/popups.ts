import { id } from "./ids.js";
import { bump, db } from "./state.js";

/** kind: shutdown | back | question | proposal | reply. Shutdowns show big. */
export async function popup(kind: string, title: string, body = "", refId: string | null = null): Promise<string> {
  const popupId = id();
  try {
    await db().query(`INSERT INTO popups (id, kind, title, body, ref_id) VALUES ($1,$2,$3,$4,$5)`, [popupId, kind, title.slice(0, 300), body, refId]);
    bump();
  } catch { /* no database yet */ }
  return popupId;
}

export async function openPopups() {
  const r = await db().query<{ id: string; kind: string; title: string; body: string; ref_id: string | null; created_at: string }>(
    `SELECT id, kind, title, body, ref_id, created_at FROM popups WHERE seen = false ORDER BY created_at`);
  return r.rows;
}

export async function dismissPopup(popupId: string) {
  await db().query(`UPDATE popups SET seen = true WHERE id = $1`, [popupId]);
  bump();
}
