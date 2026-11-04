import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import { id } from "../ids.js";
import { logAction } from "../repo.js";

/** The brick web: storage only. See MIND_DESIGN.md. Nothing here is ever deleted; a fresh start sets archived_at. */

export interface Brick {
  id: string;
  name: string;
  kind: string;
  origin: string;
  summary: string;
  contact: string;
  sourceId: string | null;
  litCount: number;
  lastLitAt: string | null;
  lastRevisitedAt: string | null;
  warmth: number;
  createdAt: string;
}

export interface Link {
  id: string;
  a: string;
  b: string;
  type: string;
  strength: number;
  reason: string;
  madeBy: string;
  usedCount: number;
}

export interface Entry {
  id: string;
  brickId: string;
  kind: string;
  text: string;
  origin: string;
  status: string;
  statusNote: string;
  createdAt: string;
}

export interface AgendaItem {
  id: string;
  kind: string;
  text: string;
  why: string;
  nextStep: string;
  status: string;
  closeNote: string;
  createdAt: string;
  closedAt: string | null;
}

/** Warmth halves roughly every six hours: on its mind for a while, mostly gone by the next morning. */
const WARMTH_TAU_HOURS = 8.5;
/** No link may grow more than this strong, so a few paths cannot swallow everything. */
export const STRENGTH_CAP = 6;

const LINK_RANK: Record<string, number> = { together: 1, source: 0, used: 2, meaning: 3, about: 4, insight: 5 };

/** Short, readable ids: models copy them reliably, and they cost few tokens. */
export function shortId(prefix: string): string {
  return `${prefix}${randomBytes(4).toString("base64url").replace(/[-_]/g, "x").slice(0, 5).toLowerCase()}`;
}

const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);

export function warmthNow(warmth: number, at: string | null, now = Date.now()): number {
  if (!at || !warmth) return 0;
  const hours = (now - new Date(at).getTime()) / 3_600_000;
  return warmth * Math.exp(-Math.max(0, hours) / WARMTH_TAU_HOURS);
}

function mapBrick(row: Record<string, unknown>): Brick {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: String(row.kind),
    origin: String(row.origin),
    summary: String(row.summary ?? ""),
    contact: String(row.contact ?? ""),
    sourceId: row.source_id ? String(row.source_id) : null,
    litCount: Number(row.lit_count ?? 0),
    lastLitAt: iso(row.last_lit_at),
    lastRevisitedAt: iso(row.last_revisited_at),
    warmth: warmthNow(Number(row.warmth ?? 0), iso(row.warmth_at)),
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
  };
}

const mapLink = (row: Record<string, unknown>): Link => ({
  id: String(row.id),
  a: String(row.a),
  b: String(row.b),
  type: String(row.type),
  strength: Number(row.strength),
  reason: String(row.reason ?? ""),
  madeBy: String(row.made_by ?? "code"),
  usedCount: Number(row.used_count ?? 0),
});

const mapEntry = (row: Record<string, unknown>): Entry => ({
  id: String(row.id),
  brickId: String(row.brick_id),
  kind: String(row.kind),
  text: String(row.text),
  origin: String(row.origin),
  status: String(row.status),
  statusNote: String(row.status_note ?? ""),
  createdAt: iso(row.created_at) ?? "",
});

const mapAgenda = (row: Record<string, unknown>): AgendaItem => ({
  id: String(row.id),
  kind: String(row.kind),
  text: String(row.text),
  why: String(row.why ?? ""),
  nextStep: String(row.next_step ?? ""),
  status: String(row.status),
  closeNote: String(row.close_note ?? ""),
  createdAt: iso(row.created_at) ?? "",
  closedAt: iso(row.closed_at),
});

export async function addSource(db: Db, userId: string, input: { kind: string; title: string; body: string }): Promise<string> {
  const sourceId = shortId("s");
  await db.query(`INSERT INTO brain_sources (id, user_id, kind, title, body) VALUES ($1,$2,$3,$4,$5)`, [sourceId, userId, input.kind, input.title.slice(0, 300), input.body]);
  return sourceId;
}

export async function getSource(db: Db, userId: string, sourceId: string): Promise<{ id: string; kind: string; title: string; body: string; createdAt: string } | null> {
  const row = (await db.query(`SELECT * FROM brain_sources WHERE id = $1 AND user_id = $2`, [sourceId, userId])).rows[0];
  return row ? { id: String(row.id), kind: String(row.kind), title: String(row.title), body: String(row.body), createdAt: iso(row.created_at) ?? "" } : null;
}

export async function addStream(db: Db, userId: string, input: { kind: string; sourceId?: string | null; content: string }): Promise<string> {
  const streamId = id();
  await db.query(`INSERT INTO brain_stream (id, user_id, kind, source_id, content) VALUES ($1,$2,$3,$4,$5)`, [streamId, userId, input.kind, input.sourceId ?? null, input.content]);
  return streamId;
}

export async function listBricks(db: Db, userId: string): Promise<Brick[]> {
  const rows = (await db.query(`SELECT * FROM bricks WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at`, [userId])).rows;
  return rows.map(mapBrick);
}

export async function getBrick(db: Db, userId: string, brickId: string): Promise<Brick | null> {
  const row = (await db.query(`SELECT * FROM bricks WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`, [brickId, userId])).rows[0];
  return row ? mapBrick(row) : null;
}

export async function listLinks(db: Db, userId: string): Promise<Link[]> {
  return (await db.query(`SELECT * FROM brick_links WHERE user_id = $1 AND archived_at IS NULL`, [userId])).rows.map(mapLink);
}

export async function listEntries(db: Db, userId: string, opts: { brickId?: string; status?: string } = {}): Promise<Entry[]> {
  const params: unknown[] = [userId];
  let where = `user_id = $1 AND archived_at IS NULL`;
  if (opts.brickId) { params.push(opts.brickId); where += ` AND brick_id = $${params.length}`; }
  if (opts.status) { params.push(opts.status); where += ` AND status = $${params.length}`; }
  return (await db.query(`SELECT * FROM brick_entries WHERE ${where} ORDER BY created_at`, params)).rows.map(mapEntry);
}

export const norm = (name: string) => name.toLowerCase().replace(/[’']s\b/g, "").replace(/\(.*?\)/g, "").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

export function findByName(bricks: Brick[], name: string): Brick | undefined {
  const n = norm(name);
  if (!n) return undefined;
  return bricks.find((b) => norm(b.name) === n);
}

export async function createBrick(
  db: Db,
  userId: string,
  input: { name: string; kind?: string; origin?: string; summary?: string; contact?: string; sourceId?: string | null },
): Promise<string> {
  const brickId = shortId("b");
  await db.query(
    `INSERT INTO bricks (id, user_id, name, kind, origin, summary, contact, source_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [brickId, userId, input.name.trim().slice(0, 120), (input.kind || "thing").slice(0, 30), input.origin || "his", (input.summary || "").slice(0, 600), (input.contact || "").slice(0, 400), input.sourceId ?? null],
  );
  return brickId;
}

export async function updateBrick(db: Db, userId: string, brickId: string, input: { summary?: string; contact?: string; name?: string }): Promise<void> {
  if (input.summary != null) await db.query(`UPDATE bricks SET summary = $3, updated_at = now() WHERE id = $1 AND user_id = $2`, [brickId, userId, input.summary.slice(0, 600)]);
  if (input.contact) {
    // Contact details add up: a new detail is appended, an old one is never overwritten.
    const row = (await db.query(`SELECT contact FROM bricks WHERE id = $1 AND user_id = $2`, [brickId, userId])).rows[0];
    const now = String(row?.contact ?? "");
    if (!now.includes(input.contact.trim())) await db.query(`UPDATE bricks SET contact = $3, updated_at = now() WHERE id = $1 AND user_id = $2`, [brickId, userId, [now, input.contact.trim()].filter(Boolean).join("; ").slice(0, 600)]);
  }
}

export async function addMoment(db: Db, userId: string, input: { brickId: string; streamId?: string | null; sourceId?: string | null; quote: string }): Promise<void> {
  await db.query(`INSERT INTO brick_moments (id, user_id, brick_id, stream_id, source_id, quote) VALUES ($1,$2,$3,$4,$5,$6)`, [id(), userId, input.brickId, input.streamId ?? null, input.sourceId ?? null, input.quote.slice(0, 600)]);
}

export async function addEntry(db: Db, userId: string, input: { brickId: string; kind: string; text: string; origin: string; streamId?: string | null; status?: string }): Promise<string> {
  const entryId = shortId("e");
  await db.query(
    `INSERT INTO brick_entries (id, user_id, brick_id, kind, text, origin, status, stream_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [entryId, userId, input.brickId, (input.kind || "fact").slice(0, 30), input.text.slice(0, 1200), input.origin, input.status || (input.kind === "question" || input.kind === "lead" || input.kind === "todo" ? "open" : "kept"), input.streamId ?? null],
  );
  return entryId;
}

export async function setEntryStatus(db: Db, userId: string, entryId: string, status: string, note: string): Promise<Entry | null> {
  const row = (await db.query(`UPDATE brick_entries SET status = $3, status_note = $4, updated_at = now() WHERE id = $1 AND user_id = $2 AND archived_at IS NULL RETURNING *`, [entryId, userId, status, note.slice(0, 600)])).rows[0];
  return row ? mapEntry(row) : null;
}

/** One link per pair. A second link between the same pair strengthens it and keeps the more telling type and every reason. */
export async function linkBricks(
  db: Db,
  userId: string,
  input: { a: string; b: string; type: string; strength?: number; reason?: string; madeBy?: string },
): Promise<void> {
  if (!input.a || !input.b || input.a === input.b) return;
  const [a, b] = [input.a, input.b].sort();
  const existing = (await db.query(`SELECT * FROM brick_links WHERE user_id = $1 AND a = $2 AND b = $3 AND archived_at IS NULL`, [userId, a, b])).rows[0];
  const add = input.strength ?? 1;
  const reason = (input.reason ?? "").trim();
  if (!existing) {
    await db.query(`INSERT INTO brick_links (id, user_id, a, b, type, strength, reason, made_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id(), userId, a, b, input.type, Math.min(add, STRENGTH_CAP), reason.slice(0, 400), input.madeBy ?? "code"]);
    return;
  }
  const type = (LINK_RANK[input.type] ?? 0) > (LINK_RANK[String(existing.type)] ?? 0) ? input.type : String(existing.type);
  const reasons = String(existing.reason ?? "");
  const nextReason = reason && !reasons.includes(reason) ? [reasons, reason].filter(Boolean).join(" · ").slice(0, 600) : reasons;
  await db.query(
    `UPDATE brick_links SET type = $2, strength = LEAST($3, strength + $4), reason = $5, updated_at = now() WHERE id = $1`,
    [existing.id, type, STRENGTH_CAP, input.type === "together" || input.type === "source" ? add * 0.3 : add * 0.5, nextReason],
  );
}

/** Using a path strengthens it: what was used together gets linked, or its link grows. Used bricks get warm. */
export async function learnFromUse(db: Db, userId: string, used: string[], lit: string[] = []): Promise<void> {
  const live = new Set((await listBricks(db, userId)).map((b) => b.id));
  const ids = [...new Set(used)].filter((x) => live.has(x));
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const [a, b] = [ids[i], ids[j]].sort();
      const existing = (await db.query(`SELECT id FROM brick_links WHERE user_id = $1 AND a = $2 AND b = $3 AND archived_at IS NULL`, [userId, a, b])).rows[0];
      if (existing) await db.query(`UPDATE brick_links SET strength = LEAST($2, strength + 0.6), used_count = used_count + 1, updated_at = now() WHERE id = $1`, [existing.id, STRENGTH_CAP]);
      else await db.query(`INSERT INTO brick_links (id, user_id, a, b, type, strength, reason, made_by, used_count) VALUES ($1,$2,$3,$4,'used',1,'used together in a thought','code',1)`, [id(), userId, a, b]);
    }
  }
  for (const brickId of ids) {
    await db.query(`UPDATE bricks SET lit_count = lit_count + 1, last_lit_at = now(), warmth = 1, warmth_at = now() WHERE id = $1 AND user_id = $2`, [brickId, userId]);
  }
  for (const brickId of lit.filter((x) => live.has(x) && !ids.includes(x))) {
    await db.query(`UPDATE bricks SET last_lit_at = now() WHERE id = $1 AND user_id = $2`, [brickId, userId]);
  }
}

export async function markRevisited(db: Db, userId: string, brickId: string): Promise<void> {
  await db.query(`UPDATE bricks SET last_revisited_at = now() WHERE id = $1 AND user_id = $2`, [brickId, userId]);
}

export async function listAgenda(db: Db, userId: string, opts: { open?: boolean } = {}): Promise<AgendaItem[]> {
  const rows = (
    await db.query(`SELECT * FROM agenda WHERE user_id = $1 AND archived_at IS NULL ${opts.open ? "AND status = 'open'" : ""} ORDER BY created_at`, [userId])
  ).rows;
  return rows.map(mapAgenda);
}

export async function addAgenda(db: Db, userId: string, input: { kind: string; text: string; why?: string; nextStep?: string; brickId?: string | null }): Promise<string> {
  const agendaId = shortId("a");
  await db.query(`INSERT INTO agenda (id, user_id, kind, text, why, next_step, brick_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [agendaId, userId, input.kind, input.text.slice(0, 600), (input.why ?? "").slice(0, 600), (input.nextStep ?? "").slice(0, 600), input.brickId ?? null]);
  await logAction(db, userId, { what: `agenda: ${input.kind} added`, why: input.text.slice(0, 300), source: "agent", payload: { agendaId } });
  return agendaId;
}

export async function closeAgenda(db: Db, userId: string, agendaId: string, status: "done" | "dropped", note: string): Promise<AgendaItem | null> {
  const row = (await db.query(`UPDATE agenda SET status = $3, close_note = $4, closed_at = now() WHERE id = $1 AND user_id = $2 AND status = 'open' RETURNING *`, [agendaId, userId, status, note.slice(0, 600)])).rows[0];
  if (row) await logAction(db, userId, { what: `agenda: ${status}`, why: `${String(row.text).slice(0, 200)}${note ? ` (${note.slice(0, 200)})` : ""}`, source: "agent", payload: { agendaId } });
  return row ? mapAgenda(row) : null;
}

export async function updateAgendaStep(db: Db, userId: string, agendaId: string, nextStep: string): Promise<boolean> {
  const row = (await db.query(`UPDATE agenda SET next_step = $3 WHERE id = $1 AND user_id = $2 AND status = 'open' RETURNING id`, [agendaId, userId, nextStep.slice(0, 600)])).rows[0];
  return Boolean(row);
}

export async function brickDetail(db: Db, userId: string, brickId: string) {
  const brick = await getBrick(db, userId, brickId);
  if (!brick) return null;
  const [moments, entries, links, bricks] = await Promise.all([
    db.query(
      `SELECT m.quote, m.created_at, s.title AS source_title, s.kind AS source_kind, m.source_id FROM brick_moments m LEFT JOIN brain_sources s ON s.id = m.source_id
       WHERE m.user_id = $1 AND m.brick_id = $2 AND m.archived_at IS NULL ORDER BY m.created_at`,
      [userId, brickId],
    ),
    listEntries(db, userId, { brickId }),
    db.query(`SELECT * FROM brick_links WHERE user_id = $1 AND archived_at IS NULL AND (a = $2 OR b = $2) ORDER BY strength DESC`, [userId, brickId]),
    listBricks(db, userId),
  ]);
  const nameOf = new Map(bricks.map((b) => [b.id, b.name]));
  return {
    brick,
    moments: moments.rows.map((r) => ({ quote: String(r.quote), at: iso(r.created_at), source: r.source_title ? String(r.source_title) : "chat", sourceKind: r.source_kind ? String(r.source_kind) : "chat", sourceId: r.source_id ? String(r.source_id) : null })),
    entries,
    links: links.rows.map(mapLink).map((l) => ({ ...l, other: l.a === brickId ? l.b : l.a, otherName: nameOf.get(l.a === brickId ? l.b : l.a) ?? "?" })),
  };
}

/** Archive the whole web for a fresh start. Rows stay. */
export async function archiveBrain(db: Db, userId: string): Promise<void> {
  for (const table of ["brain_sources", "brain_stream", "bricks", "brick_moments", "brick_entries", "brick_links", "agenda", "brain_sessions", "brain_activations"]) {
    await db.query(`UPDATE ${table} SET archived_at = COALESCE(archived_at, now()) WHERE user_id = $1 AND archived_at IS NULL`, [userId]);
  }
}
