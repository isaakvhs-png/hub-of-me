import { embedOwners } from "./embed.js";
import { iso, json, sid } from "./store.js";
import type { Ctx } from "./steps.js";

/**
 * Rings 2..n and the centre (BUILD_SPEC §5.3). A page has a purpose (the question it answers), a body that cites what it
 * is made of ([[b:id]] bricks, [[p:id]] pages, [[s:id]] sources), many-to-many members and every version kept.
 * Code refuses a page that cites something that does not exist, or that would sit inside itself.
 * Its level is computed: 1 + the highest level among its member pages. The life document is the one page of kind "life".
 */
export type PageKind = "page" | "life" | "guide" | "track" | "project";
export interface Page { id: string; kind: PageKind; title: string; purpose: string; body: string; status: string; version: number; origin: string; updatedAt: string; createdAt: string; lastUsedAt: string | null }

export class CitationError extends Error {}

const mapPage = (r: Record<string, unknown>): Page => ({
  id: String(r.id), kind: String(r.kind) as PageKind, title: String(r.title), purpose: String(r.purpose ?? ""), body: String(r.body ?? ""),
  status: String(r.status), version: Number(r.version), origin: String(r.origin), updatedAt: iso(r.updated_at), createdAt: iso(r.created_at),
  lastUsedAt: r.last_used_at == null ? null : iso(r.last_used_at),
});

export const CITE = /\[\[([bps]):([a-z0-9]+)(?:\|[^\]]*)?\]\]/g;

export function citations(body: string): { kind: "brick" | "page" | "source"; id: string }[] {
  const out: { kind: "brick" | "page" | "source"; id: string }[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(CITE)) {
    const kind = m[1] === "b" ? "brick" : m[1] === "p" ? "page" : "source";
    const key = `${kind}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, id: m[2] });
  }
  return out;
}

async function exists(ctx: Ctx, kind: string, id: string): Promise<boolean> {
  const table = kind === "brick" ? "bricks" : kind === "page" ? "pages" : "sources";
  const r = await ctx.db.query(`SELECT 1 FROM ${table} WHERE user_id=$1 AND id=$2 AND archived_at IS NULL`, [ctx.userId, id]);
  return r.rows.length > 0;
}

/** Every citation must exist; a page may not contain itself (directly or further down). */
export async function checkCitations(ctx: Ctx, body: string, selfId?: string): Promise<{ kind: "brick" | "page" | "source"; id: string }[]> {
  const cites = citations(body);
  const missing: string[] = [];
  for (const c of cites) if (!(await exists(ctx, c.kind, c.id))) missing.push(`${c.kind} ${c.id}`);
  if (missing.length) throw new CitationError(`The page cites what does not exist: ${missing.join(", ")}. Cite only ids from your pack.`);
  if (selfId) {
    for (const c of cites.filter((x) => x.kind === "page")) {
      if (c.id === selfId || (await descendants(ctx, c.id)).has(selfId)) throw new CitationError(`A page cannot sit inside itself (page ${c.id} already contains this one).`);
    }
  }
  return cites;
}

async function descendants(ctx: Ctx, pageId: string, seen = new Set<string>()): Promise<Set<string>> {
  const r = await ctx.db.query<{ member_id: string }>(`SELECT member_id FROM page_members WHERE user_id=$1 AND page_id=$2 AND member_kind='page' AND archived_at IS NULL`, [ctx.userId, pageId]);
  for (const row of r.rows) {
    if (seen.has(row.member_id)) continue;
    seen.add(row.member_id);
    await descendants(ctx, row.member_id, seen);
  }
  return seen;
}

async function setMembers(ctx: Ctx, pageId: string, members: { kind: string; id: string }[], addedBy: string): Promise<void> {
  const current = await ctx.db.query<{ member_kind: string; member_id: string; id: string }>(`SELECT id, member_kind, member_id FROM page_members WHERE user_id=$1 AND page_id=$2 AND archived_at IS NULL`, [ctx.userId, pageId]);
  const want = new Set(members.map((m) => `${m.kind}:${m.id}`));
  for (const row of current.rows) if (!want.has(`${row.member_kind}:${row.member_id}`)) await ctx.db.query(`UPDATE page_members SET archived_at=now() WHERE id=$1`, [row.id]);
  const have = new Set(current.rows.map((r) => `${r.member_kind}:${r.member_id}`));
  for (const m of members) {
    if (have.has(`${m.kind}:${m.id}`)) continue;
    await ctx.db.query(`INSERT INTO page_members (id, user_id, page_id, member_kind, member_id, added_by) VALUES ($1,$2,$3,$4,$5,$6)`, [sid(), ctx.userId, pageId, m.kind, m.id, addedBy]);
  }
}

export async function createPage(ctx: Ctx & { runId?: string }, input: { kind?: PageKind; title: string; purpose: string; body: string; origin?: "own" | "his" }): Promise<Page> {
  const kind = input.kind ?? "page";
  if (kind === "life" && (await lifeDocument(ctx))) throw new CitationError("There is already a life document; revise it instead.");
  const cites = await checkCitations(ctx, input.body);
  const pageId = sid();
  const at = ctx.now().toISOString();
  await ctx.db.query(`INSERT INTO pages (id, user_id, kind, title, purpose, body, status, version, origin, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,'fresh',1,$7,$8,$8)`,
    [pageId, ctx.userId, kind, input.title.slice(0, 200), input.purpose.slice(0, 500), input.body, input.origin ?? "own", at]);
  await ctx.db.query(`INSERT INTO page_versions (id, user_id, page_id, version, title, body, change_note, claim_changed, run_id, at) VALUES ($1,$2,$3,1,$4,$5,'first version',true,$6,$7)`,
    [sid(), ctx.userId, pageId, input.title, input.body, ctx.runId ?? null, at]);
  await setMembers(ctx, pageId, cites, "citation");
  await embedOwners(ctx, [{ kind: "page", id: pageId, text: `${input.title}\n${input.purpose}\n${input.body.slice(0, 6000)}` }]);
  return (await getPage(ctx, pageId))!;
}

export async function revisePage(ctx: Ctx & { runId?: string }, pageId: string, input: { body: string; title?: string; purpose?: string; changeNote: string; claimChanged: boolean; reasonChain?: string[] }): Promise<Page> {
  const page = await getPage(ctx, pageId);
  if (!page) throw new CitationError(`No page ${pageId}.`);
  const cites = await checkCitations(ctx, input.body, pageId);
  const version = page.version + 1;
  const at = ctx.now().toISOString();
  await ctx.db.query(`UPDATE pages SET title=$3, purpose=$4, body=$5, version=$6, status='fresh', updated_at=$7, reviewed_at=$7 WHERE user_id=$1 AND id=$2`,
    [ctx.userId, pageId, (input.title ?? page.title).slice(0, 200), (input.purpose ?? page.purpose).slice(0, 500), input.body, version, at]);
  await ctx.db.query(`INSERT INTO page_versions (id, user_id, page_id, version, title, body, change_note, claim_changed, reason_chain, run_id, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [sid(), ctx.userId, pageId, version, input.title ?? page.title, input.body, input.changeNote, input.claimChanged, JSON.stringify(input.reasonChain ?? []), ctx.runId ?? null, at]);
  await setMembers(ctx, pageId, cites, "citation");
  await embedOwners(ctx, [{ kind: "page", id: pageId, text: `${input.title ?? page.title}\n${input.purpose ?? page.purpose}\n${input.body.slice(0, 6000)}` }]);
  return (await getPage(ctx, pageId))!;
}

export async function getPage(ctx: Ctx, pageId: string): Promise<Page | null> {
  const r = await ctx.db.query(`SELECT * FROM pages WHERE user_id=$1 AND id=$2 AND archived_at IS NULL`, [ctx.userId, pageId]);
  return r.rows[0] ? mapPage(r.rows[0]) : null;
}

export async function listPages(ctx: Ctx, kind?: PageKind): Promise<Page[]> {
  const r = await ctx.db.query(`SELECT * FROM pages WHERE user_id=$1 AND archived_at IS NULL ${kind ? "AND kind=$2" : ""} ORDER BY created_at`, kind ? [ctx.userId, kind] : [ctx.userId]);
  return r.rows.map(mapPage);
}

export async function findPageByTitle(ctx: Ctx, title: string): Promise<Page | null> {
  const r = await ctx.db.query(`SELECT * FROM pages WHERE user_id=$1 AND lower(title)=lower($2) AND archived_at IS NULL LIMIT 1`, [ctx.userId, title.trim()]);
  return r.rows[0] ? mapPage(r.rows[0]) : null;
}

export async function lifeDocument(ctx: Ctx): Promise<Page | null> {
  const r = await ctx.db.query(`SELECT * FROM pages WHERE user_id=$1 AND kind='life' AND archived_at IS NULL ORDER BY created_at LIMIT 1`, [ctx.userId]);
  return r.rows[0] ? mapPage(r.rows[0]) : null;
}

export async function members(ctx: Ctx, pageId: string): Promise<{ kind: string; id: string }[]> {
  const r = await ctx.db.query<{ member_kind: string; member_id: string }>(`SELECT member_kind, member_id FROM page_members WHERE user_id=$1 AND page_id=$2 AND archived_at IS NULL`, [ctx.userId, pageId]);
  return r.rows.map((m) => ({ kind: m.member_kind, id: m.member_id }));
}

/** Pages that have this brick, page or source as a member. */
export async function pagesContaining(ctx: Ctx, kind: string, memberId: string): Promise<string[]> {
  const r = await ctx.db.query<{ page_id: string }>(`SELECT DISTINCT page_id FROM page_members WHERE user_id=$1 AND member_kind=$2 AND member_id=$3 AND archived_at IS NULL`, [ctx.userId, kind, memberId]);
  return r.rows.map((x) => x.page_id);
}

/** Levels, computed: a page of only bricks is 1; a page of pages is one more than its highest member. Life is the centre. */
export async function pageLevels(ctx: Ctx): Promise<Map<string, number>> {
  const pages = await listPages(ctx);
  const r = await ctx.db.query<{ page_id: string; member_id: string }>(`SELECT page_id, member_id FROM page_members WHERE user_id=$1 AND member_kind='page' AND archived_at IS NULL`, [ctx.userId]);
  const kids = new Map<string, string[]>();
  for (const row of r.rows) kids.set(row.page_id, [...(kids.get(row.page_id) ?? []), row.member_id]);
  const memo = new Map<string, number>();
  const level = (id: string, stack: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (stack.has(id)) return 1;
    stack.add(id);
    const below = (kids.get(id) ?? []).map((k) => level(k, stack));
    stack.delete(id);
    const v = 1 + (below.length ? Math.max(...below) : 0);
    memo.set(id, v);
    return v;
  };
  for (const p of pages) level(p.id, new Set());
  return memo;
}

/**
 * Themes: the top pages (not inside any page except the life document), of kind page or project.
 * The model decides themes by how it builds pages; code only finds the top and draws.
 */
export async function themes(ctx: Ctx): Promise<Page[]> {
  const pages = (await listPages(ctx)).filter((p) => p.kind === "page" || p.kind === "project");
  const life = await lifeDocument(ctx);
  const r = await ctx.db.query<{ page_id: string; member_id: string }>(`SELECT page_id, member_id FROM page_members WHERE user_id=$1 AND member_kind='page' AND archived_at IS NULL`, [ctx.userId]);
  const inside = new Set(r.rows.filter((row) => row.page_id !== life?.id).map((row) => row.member_id));
  return pages.filter((p) => !inside.has(p.id));
}

export async function pageVersions(ctx: Ctx, pageId: string): Promise<{ version: number; title: string; body: string; changeNote: string; claimChanged: boolean; reasonChain: string[]; at: string }[]> {
  const r = await ctx.db.query(`SELECT * FROM page_versions WHERE user_id=$1 AND page_id=$2 ORDER BY version`, [ctx.userId, pageId]);
  return r.rows.map((v) => ({ version: Number(v.version), title: String(v.title), body: String(v.body), changeNote: String(v.change_note), claimChanged: v.claim_changed === true || v.claim_changed === "t", reasonChain: json<string[]>(v.reason_chain, []), at: iso(v.at) }));
}

export async function touchPages(ctx: Ctx, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await ctx.db.query(`UPDATE pages SET last_used_at=$2 WHERE user_id=$1 AND id = ANY($3::text[])`, [ctx.userId, ctx.now().toISOString(), ids]);
}

/** The opening and the headings of a long page (the life document beyond its knob). */
export function openingAndHeadings(body: string, openingChars = 3000): string {
  const headings = body.split("\n").filter((l) => /^#{1,4}\s/.test(l));
  return `${body.slice(0, openingChars)}${body.length > openingChars ? "\n…\n(headings of the rest)\n" + headings.join("\n") : ""}`;
}
