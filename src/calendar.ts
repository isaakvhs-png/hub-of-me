import { id } from "./ids.js";
import { ValidationError, NotFoundError } from "./errors.js";
import { addSource } from "./web.js";
import { bump, db } from "./state.js";

/** The calendar tab (inside the app). Every item is a source and feeds into summaries. */

function when(raw: string, what: string): Date {
  const d = new Date(raw);
  if (!raw || Number.isNaN(d.getTime())) throw new ValidationError(`${what} is not a date and time: "${raw}"`);
  return d;
}

function describe(e: { title: string; startsAt: Date; endsAt: Date; allDay: boolean; note: string }, verb: string) {
  const span = e.allDay ? `all day on ${e.startsAt.toISOString().slice(0, 10)}` : `${e.startsAt.toISOString()} to ${e.endsAt.toISOString()}`;
  return `Calendar: ${verb} "${e.title}", ${span}.${e.note ? ` Note: ${e.note}` : ""}`;
}

export async function addEvent(e: { title: string; startsAt: string; endsAt?: string; allDay?: boolean; note?: string; by: "isaak" | "it" }): Promise<string> {
  const title = e.title.trim();
  if (!title) throw new ValidationError("An appointment needs a title.");
  const startsAt = when(e.startsAt, "The start");
  const endsAt = e.endsAt ? when(e.endsAt, "The end") : new Date(startsAt.getTime() + (e.allDay ? 24 : 1) * 3600_000);
  if (endsAt < startsAt) throw new ValidationError("The end is before the start.");
  const eventId = id();
  const sourceId = await addSource({ kind: "calendar", origin: e.by === "isaak" ? "isaak" : "self", title: `Calendar: ${title.slice(0, 200)}`,
    text: describe({ title, startsAt, endsAt, allDay: Boolean(e.allDay), note: e.note ?? "" }, e.by === "isaak" ? "Isaak added" : "added by its own judgement") });
  await db().query(`INSERT INTO calendar (id, title, starts_at, ends_at, all_day, note, by, source_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [eventId, title.slice(0, 300), startsAt.toISOString(), endsAt.toISOString(), Boolean(e.allDay), e.note ?? "", e.by, sourceId]);
  bump();
  return eventId;
}

export async function updateEvent(eventId: string, e: { title?: string; startsAt?: string; endsAt?: string; allDay?: boolean; note?: string }): Promise<void> {
  const r = await db().query<{ title: string; starts_at: string; ends_at: string; all_day: boolean; note: string }>(`SELECT * FROM calendar WHERE id = $1 AND deleted_at IS NULL`, [eventId]);
  const old = r.rows[0];
  if (!old) throw new NotFoundError("No such appointment.");
  const next = {
    title: (e.title ?? old.title).trim(),
    startsAt: e.startsAt ? when(e.startsAt, "The start") : new Date(old.starts_at),
    endsAt: e.endsAt ? when(e.endsAt, "The end") : new Date(old.ends_at),
    allDay: e.allDay ?? old.all_day,
    note: e.note ?? old.note,
  };
  if (!next.title) throw new ValidationError("An appointment needs a title.");
  if (next.endsAt < next.startsAt) throw new ValidationError("The end is before the start.");
  await db().query(`UPDATE calendar SET title=$2, starts_at=$3, ends_at=$4, all_day=$5, note=$6 WHERE id=$1`, [eventId, next.title, next.startsAt.toISOString(), next.endsAt.toISOString(), next.allDay, next.note]);
  await addSource({ kind: "calendar", origin: "isaak", title: `Calendar: ${next.title}`, text: describe(next, "Isaak changed") });
  bump();
}

export async function deleteEvent(eventId: string): Promise<void> {
  const r = await db().query<{ title: string }>(`UPDATE calendar SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING title`, [eventId]);
  if (!r.rows[0]) throw new NotFoundError("No such appointment.");
  await addSource({ kind: "calendar", origin: "isaak", title: `Calendar: removed ${r.rows[0].title}`, text: `Calendar: Isaak removed "${r.rows[0].title}".` });
  bump();
}

/** Items in a range, each with the labels of the summaries it feeds (the same filters as the tree). */
export async function listEvents(fromIso: string, toIso: string) {
  const from = when(fromIso, "The from date"); const to = when(toIso, "The to date");
  const r = await db().query<{ id: string; title: string; starts_at: string; ends_at: string; all_day: boolean; note: string; by: string; source_id: string | null }>(
    `SELECT id, title, starts_at, ends_at, all_day, note, by, source_id FROM calendar WHERE deleted_at IS NULL AND starts_at < $2 AND ends_at > $1 ORDER BY starts_at`, [from.toISOString(), to.toISOString()]);
  const out = [];
  for (const row of r.rows) {
    const t = row.source_id ? await db().query<{ tags: string; id: string }>(`SELECT s.id, s.tags FROM feeds f JOIN summaries s ON s.id = f.summary_id WHERE f.input_type = 'source' AND f.input_id = $1`, [row.source_id]) : { rows: [] };
    const tags = new Set<string>();
    for (const x of t.rows) { try { for (const tag of JSON.parse(x.tags)) tags.add(String(tag)); } catch { /* none */ } }
    out.push({ ...row, tags: [...tags], summaries: t.rows.map((x) => x.id) });
  }
  return out;
}
