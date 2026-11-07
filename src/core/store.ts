import { randomBytes } from "node:crypto";
import { emit } from "./bus.js";
import type { Ctx } from "./steps.js";

/** Short ids (10 characters): they are read by models in every index and citation, so they stay small. */
export function sid(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(10);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export const iso = (v: unknown): string => (v == null ? "" : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
export const json = <T>(v: unknown, fallback: T): T => {
  if (v == null || v === "") return fallback;
  if (typeof v !== "string") return v as T;
  try { return JSON.parse(v) as T; } catch { return fallback; }
};
export const truthy = (v: unknown) => v === true || v === "t" || v === "true";

// ---------- Ring 0: the stream and sources ----------

export interface StreamRow { id: string; kind: "his" | "its" | "system"; content: string; sentWithSource: string | null; clientMsgId: string | null; runId: string | null; at: string; filedAt: string | null }

const mapStream = (r: Record<string, unknown>): StreamRow => ({
  id: String(r.id), kind: String(r.kind) as StreamRow["kind"], content: String(r.content),
  sentWithSource: r.sent_with_source == null ? null : String(r.sent_with_source),
  clientMsgId: r.client_msg_id == null ? null : String(r.client_msg_id),
  runId: r.run_id == null ? null : String(r.run_id), at: iso(r.at), filedAt: r.filed_at == null ? null : iso(r.filed_at),
});

export async function addStream(ctx: Ctx, input: { kind: StreamRow["kind"]; content: string; sentWithSource?: string | null; clientMsgId?: string | null; runId?: string | null }): Promise<StreamRow> {
  const rowId = sid();
  const at = ctx.now().toISOString();
  await ctx.db.query(
    `INSERT INTO stream (id, user_id, kind, content, sent_with_source, client_msg_id, run_id, at, filed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [rowId, ctx.userId, input.kind, input.content, input.sentWithSource ?? null, input.clientMsgId ?? null, input.runId ?? null, at,
      input.kind === "system" ? at : null],
  );
  emit(ctx.userId, { type: "chat", id: rowId, kind: input.kind, content: input.content, runId: input.runId ?? null, at });
  return { id: rowId, kind: input.kind, content: input.content, sentWithSource: input.sentWithSource ?? null, clientMsgId: input.clientMsgId ?? null, runId: input.runId ?? null, at, filedAt: null };
}

export async function streamByClientId(ctx: Ctx, clientMsgId: string): Promise<StreamRow | null> {
  const r = await ctx.db.query(`SELECT * FROM stream WHERE user_id=$1 AND client_msg_id=$2 AND archived_at IS NULL LIMIT 1`, [ctx.userId, clientMsgId]);
  return r.rows[0] ? mapStream(r.rows[0]) : null;
}

export async function listStream(ctx: Ctx, limit = 200): Promise<StreamRow[]> {
  const r = await ctx.db.query(`SELECT * FROM stream WHERE user_id=$1 AND archived_at IS NULL ORDER BY at DESC, id DESC LIMIT $2`, [ctx.userId, limit]);
  return r.rows.map(mapStream).reverse();
}

/** The conversation so far, newest last, cut to about this many characters. */
export async function recentConversation(ctx: Ctx, chars = 8000): Promise<StreamRow[]> {
  const rows = await listStream(ctx, 60);
  const out: StreamRow[] = [];
  let used = 0;
  for (const row of [...rows].reverse()) {
    if (row.kind === "system") continue;
    used += row.content.length;
    if (used > chars && out.length) break;
    out.unshift(row);
  }
  return out;
}

export async function lastHisMessageAt(ctx: Ctx): Promise<Date | null> {
  const r = await ctx.db.query<{ at: unknown }>(`SELECT at FROM stream WHERE user_id=$1 AND kind='his' AND archived_at IS NULL ORDER BY at DESC LIMIT 1`, [ctx.userId]);
  return r.rows[0] ? new Date(iso(r.rows[0].at)) : null;
}

export interface SourceRow { id: string; kind: string; title: string; body: string; origSize: number; storedSize: number; filed: boolean; streamId: string | null; at: string; failedParts: string[] }

const mapSource = (r: Record<string, unknown>): SourceRow => ({
  id: String(r.id), kind: String(r.kind), title: String(r.title), body: String(r.body ?? ""), origSize: Number(r.orig_size ?? 0),
  storedSize: Number(r.stored_size ?? 0), filed: truthy(r.filed), streamId: r.stream_id == null ? null : String(r.stream_id), at: iso(r.at),
  failedParts: json<string[]>(r.failed_parts, []),
});

/** Keep a source whole. Each source gets its own brick in ring 1 (kind "source"). */
export async function addSource(ctx: Ctx, input: { kind: string; title: string; body: string; origSize?: number; streamId?: string | null; filed?: boolean }): Promise<{ source: SourceRow; brickId: string }> {
  const sourceId = sid();
  const at = ctx.now().toISOString();
  const origin = input.kind === "own" ? "its" : input.kind === "web" ? "web" : "his";
  await ctx.db.query(
    `INSERT INTO sources (id, user_id, title, kind, origin, body, raw_text, orig_size, stored_size, filed, stream_id, at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'',$7,$8,$9,$10,$11,$11)`,
    [sourceId, ctx.userId, input.title.slice(0, 300), input.kind, origin, input.body, input.origSize ?? input.body.length, input.body.length, input.filed ?? false, input.streamId ?? null, at],
  );
  const brick = await createBrick(ctx, { name: input.title.slice(0, 200), kind: "source", summary: `${input.kind} kept whole (${input.body.length} characters)`, corner: input.kind === "own" ? "own" : "his", sourceId });
  return { source: { id: sourceId, kind: input.kind, title: input.title, body: input.body, origSize: input.origSize ?? input.body.length, storedSize: input.body.length, filed: input.filed ?? false, streamId: input.streamId ?? null, at, failedParts: [] }, brickId: brick.id };
}

export async function getSource(ctx: Ctx, sourceId: string): Promise<SourceRow | null> {
  const r = await ctx.db.query(`SELECT * FROM sources WHERE user_id=$1 AND id=$2 AND archived_at IS NULL`, [ctx.userId, sourceId]);
  return r.rows[0] ? mapSource(r.rows[0]) : null;
}

export async function listSources(ctx: Ctx, limit = 500): Promise<SourceRow[]> {
  const r = await ctx.db.query(`SELECT * FROM sources WHERE user_id=$1 AND archived_at IS NULL ORDER BY at DESC LIMIT $2`, [ctx.userId, limit]);
  return r.rows.map(mapSource);
}

export async function setSourceFiled(ctx: Ctx, sourceId: string, failedParts: string[]): Promise<void> {
  await ctx.db.query(`UPDATE sources SET filed=$3, failed_parts=$4 WHERE user_id=$1 AND id=$2`, [ctx.userId, sourceId, failedParts.length === 0, JSON.stringify(failedParts)]);
}

export async function sourceBrickId(ctx: Ctx, sourceId: string): Promise<string | null> {
  const r = await ctx.db.query<{ id: string }>(`SELECT id FROM bricks WHERE user_id=$1 AND source_id=$2 AND kind='source' AND archived_at IS NULL LIMIT 1`, [ctx.userId, sourceId]);
  return r.rows[0]?.id ?? null;
}

// ---------- Ring 1: bricks, entries, links ----------

export interface Brick { id: string; name: string; kind: string; summary: string; corner: "his" | "own"; sourceId: string | null; lastUsedAt: string | null; createdAt: string; updatedAt: string }

const mapBrick = (r: Record<string, unknown>): Brick => ({
  id: String(r.id), name: String(r.name), kind: String(r.kind), summary: String(r.summary ?? ""), corner: (String(r.corner ?? "his") === "own" ? "own" : "his"),
  sourceId: r.source_id == null ? null : String(r.source_id), lastUsedAt: r.last_used_at == null ? null : iso(r.last_used_at), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

export async function createBrick(ctx: Ctx, input: { name: string; kind?: string; summary?: string; corner?: "his" | "own"; sourceId?: string | null }): Promise<Brick> {
  const brickId = sid();
  const at = ctx.now().toISOString();
  const corner = input.corner === "own" ? "own" : "his";
  await ctx.db.query(
    `INSERT INTO bricks (id, user_id, name, kind, origin, summary, source_id, corner, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
    [brickId, ctx.userId, input.name.trim().slice(0, 200), (input.kind ?? "thing").slice(0, 60), corner === "own" ? "own" : "his", (input.summary ?? "").slice(0, 400), input.sourceId ?? null, corner, at],
  );
  return { id: brickId, name: input.name.trim(), kind: input.kind ?? "thing", summary: input.summary ?? "", corner, sourceId: input.sourceId ?? null, lastUsedAt: null, createdAt: at, updatedAt: at };
}

export async function getBrick(ctx: Ctx, brickId: string): Promise<Brick | null> {
  const r = await ctx.db.query(`SELECT * FROM bricks WHERE user_id=$1 AND id=$2 AND archived_at IS NULL`, [ctx.userId, brickId]);
  return r.rows[0] ? mapBrick(r.rows[0]) : null;
}

export async function listBricks(ctx: Ctx): Promise<Brick[]> {
  const r = await ctx.db.query(`SELECT * FROM bricks WHERE user_id=$1 AND archived_at IS NULL ORDER BY created_at, id`, [ctx.userId]);
  return r.rows.map(mapBrick);
}

export async function findBrickByName(ctx: Ctx, name: string): Promise<Brick | null> {
  const r = await ctx.db.query(`SELECT * FROM bricks WHERE user_id=$1 AND lower(name)=lower($2) AND archived_at IS NULL ORDER BY created_at LIMIT 1`, [ctx.userId, name.trim()]);
  return r.rows[0] ? mapBrick(r.rows[0]) : null;
}

export async function updateBrick(ctx: Ctx, brickId: string, input: { name?: string; kind?: string; summary?: string; corner?: "his" | "own" }): Promise<void> {
  const b = await getBrick(ctx, brickId);
  if (!b) return;
  await ctx.db.query(`UPDATE bricks SET name=$3, kind=$4, summary=$5, corner=$6, updated_at=$7 WHERE user_id=$1 AND id=$2`,
    [ctx.userId, brickId, (input.name ?? b.name).slice(0, 200), (input.kind ?? b.kind).slice(0, 60), (input.summary ?? b.summary).slice(0, 400), input.corner ?? b.corner, ctx.now().toISOString()]);
}

export async function touchBricks(ctx: Ctx, ids: string[], used = false): Promise<void> {
  if (!ids.length) return;
  const column = used ? "last_used_at" : "updated_at";
  await ctx.db.query(`UPDATE bricks SET ${column}=$2 WHERE user_id=$1 AND id = ANY($3::text[])`, [ctx.userId, ctx.now().toISOString(), ids]);
}

export async function archiveBrick(ctx: Ctx, brickId: string): Promise<void> {
  await ctx.db.query(`UPDATE bricks SET archived_at=$3 WHERE user_id=$1 AND id=$2`, [ctx.userId, brickId, ctx.now().toISOString()]);
}

export interface Entry { id: string; brickId: string; kind: string; text: string; origin: "his" | "web" | "own"; status: string; supersededBy: string | null; quote: string; sourceId: string | null; charStart: number | null; charEnd: number | null; dueAt: string | null; createdAt: string }

const mapEntry = (r: Record<string, unknown>): Entry => ({
  id: String(r.id), brickId: String(r.brick_id), kind: String(r.kind), text: String(r.text), origin: String(r.origin) as Entry["origin"], status: String(r.status),
  supersededBy: r.superseded_by == null ? null : String(r.superseded_by), quote: String(r.quote ?? ""), sourceId: r.source_id == null ? null : String(r.source_id),
  charStart: r.char_start == null ? null : Number(r.char_start), charEnd: r.char_end == null ? null : Number(r.char_end), dueAt: r.due_at == null ? null : iso(r.due_at), createdAt: iso(r.created_at),
});

export async function addEntry(ctx: Ctx & { runId?: string }, input: { brickId: string; kind: string; text: string; origin?: Entry["origin"]; quote?: string; sourceId?: string | null; charStart?: number | null; charEnd?: number | null; dueAt?: string | null; status?: string }): Promise<Entry> {
  const entryId = sid();
  const at = ctx.now().toISOString();
  await ctx.db.query(
    `INSERT INTO entries (id, user_id, brick_id, kind, text, origin, status, quote, source_id, char_start, char_end, due_at, run_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [entryId, ctx.userId, input.brickId, input.kind.slice(0, 60), input.text, input.origin ?? "his", input.status ?? "open", input.quote ?? "", input.sourceId ?? null,
      input.charStart ?? null, input.charEnd ?? null, input.dueAt ?? null, ctx.runId ?? null, at],
  );
  await touchBricks(ctx, [input.brickId]);
  return { id: entryId, brickId: input.brickId, kind: input.kind, text: input.text, origin: input.origin ?? "his", status: input.status ?? "open", supersededBy: null, quote: input.quote ?? "", sourceId: input.sourceId ?? null, charStart: input.charStart ?? null, charEnd: input.charEnd ?? null, dueAt: input.dueAt ?? null, createdAt: at };
}

export async function listEntries(ctx: Ctx, brickId: string, includeSuperseded = true): Promise<Entry[]> {
  const r = await ctx.db.query(`SELECT * FROM entries WHERE user_id=$1 AND brick_id=$2 AND archived_at IS NULL ${includeSuperseded ? "" : "AND status <> 'superseded'"} ORDER BY created_at, id`, [ctx.userId, brickId]);
  return r.rows.map(mapEntry);
}

export async function supersede(ctx: Ctx, entryId: string, byEntryId: string): Promise<void> {
  await ctx.db.query(`UPDATE entries SET status='superseded', superseded_by=$3 WHERE user_id=$1 AND id=$2`, [ctx.userId, entryId, byEntryId]);
}

export interface Link { id: string; a: string; b: string; relation: string; reason: string; strength: number; madeBy: string; createdAt: string }
const mapLink = (r: Record<string, unknown>): Link => ({ id: String(r.id), a: String(r.a), b: String(r.b), relation: String(r.relation), reason: String(r.reason ?? ""), strength: Number(r.strength ?? 1), madeBy: String(r.made_by ?? ""), createdAt: iso(r.created_at) });

/** Only judged links are stored (a relation and a reason). The same pair and relation twice strengthens the first. */
export async function addLink(ctx: Ctx & { runId?: string }, input: { a: string; b: string; relation: string; reason: string; madeBy: string; strength?: number }): Promise<Link | null> {
  if (input.a === input.b) return null;
  const existing = await ctx.db.query(`SELECT * FROM links WHERE user_id=$1 AND archived_at IS NULL AND relation=$4 AND ((a=$2 AND b=$3) OR (a=$3 AND b=$2)) LIMIT 1`, [ctx.userId, input.a, input.b, input.relation]);
  if (existing.rows[0]) {
    await ctx.db.query(`UPDATE links SET strength = strength + 0.5 WHERE id=$1`, [existing.rows[0].id]);
    return mapLink(existing.rows[0]);
  }
  const linkId = sid();
  await ctx.db.query(`INSERT INTO links (id, user_id, a, b, relation, reason, strength, made_by, run_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [linkId, ctx.userId, input.a, input.b, input.relation.slice(0, 60), input.reason.slice(0, 500), input.strength ?? 1, input.madeBy, ctx.runId ?? null, ctx.now().toISOString()]);
  return { id: linkId, a: input.a, b: input.b, relation: input.relation, reason: input.reason, strength: input.strength ?? 1, madeBy: input.madeBy, createdAt: ctx.now().toISOString() };
}

export async function linksOf(ctx: Ctx, nodeId: string): Promise<Link[]> {
  const r = await ctx.db.query(`SELECT * FROM links WHERE user_id=$1 AND archived_at IS NULL AND (a=$2 OR b=$2) ORDER BY strength DESC, created_at`, [ctx.userId, nodeId]);
  return r.rows.map(mapLink);
}

export async function listLinks(ctx: Ctx): Promise<Link[]> {
  const r = await ctx.db.query(`SELECT * FROM links WHERE user_id=$1 AND archived_at IS NULL`, [ctx.userId]);
  return r.rows.map(mapLink);
}

// ---------- code's own small memory ----------

export async function getMeta(ctx: { db: Ctx["db"] }, key: string): Promise<string | null> {
  const r = await ctx.db.query<{ value: string }>(`SELECT value FROM core_meta WHERE key=$1`, [key]);
  return r.rows[0]?.value ?? null;
}

export async function setMeta(ctx: { db: Ctx["db"] }, key: string, value: string): Promise<void> {
  await ctx.db.query(`INSERT INTO core_meta (key, value, at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=$2, at=now()`, [key, value]);
}
