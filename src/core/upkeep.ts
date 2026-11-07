import { extractJson } from "../json.js";
import { KNOBS } from "../knobs.js";
import { similarTo, words } from "./embed.js";
import { render } from "./look.js";
import { getPage, lifeDocument, listPages, members, pagesContaining, revisePage, type Page } from "./pages.js";
import { checkpoint } from "./queue.js";
import { getBrick, getMeta, iso, listBricks, setMeta, sid, type Brick } from "./store.js";
import { logStep, timed, type Ctx, type RunCtx } from "./steps.js";
import { systemPrompt } from "./prompts.js";

/**
 * Upkeep (BUILD_SPEC §5.4): six routes mark a page stale, each with a reason; a fast model triages
 * ("does this matter for this page?"); a good model rewrites; only a changed claim passes staleness upward.
 * One rewrite per page per root cause per day (knob). Runs only within the background share of the allowance.
 */
export type Route = "membership" | "flagged" | "mention" | "time" | "spotcheck" | "isaak";
const ROUTE_NODE: Record<Route, string> = { membership: "upkeep/routes/rmem", flagged: "upkeep/routes/rflag", mention: "upkeep/routes/rment", time: "upkeep/routes/rtime", spotcheck: "upkeep/routes/rspot", isaak: "upkeep/routes/ryou" };

export interface StaleMark { id: string; pageId: string; route: Route; reason: string; rootId: string; triage: string | null; triageWhy: string; at: string }

/** Mark a page stale (once per page and root cause while the mark is open). Returns true when a new mark was made. */
export async function markStale(ctx: Ctx & { runId?: string }, pageId: string, route: Route, reason: string, rootId: string): Promise<boolean> {
  const open = await ctx.db.query(`SELECT 1 FROM stale_marks WHERE user_id=$1 AND page_id=$2 AND root_id=$3 AND done_at IS NULL AND archived_at IS NULL`, [ctx.userId, pageId, rootId]);
  if (open.rows.length) return false;
  await ctx.db.query(`INSERT INTO stale_marks (id, user_id, page_id, route, reason, root_id, run_id, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [sid(), ctx.userId, pageId, route, reason.slice(0, 500), rootId, ctx.runId ?? null, ctx.now().toISOString()]);
  await ctx.db.query(`UPDATE pages SET status='stale' WHERE user_id=$1 AND id=$2`, [ctx.userId, pageId]);
  return true;
}

/** Route 1 (membership): a brick the page is made of was touched. */
export async function staleByMembership(ctx: RunCtx, brickIds: string[], reason: string, rootId: string): Promise<string[]> {
  const marked: string[] = [];
  for (const b of brickIds) for (const p of await pagesContaining(ctx, "brick", b)) if (await markStale(ctx, p, "membership", reason, rootId)) marked.push(p);
  if (marked.length) await logStep(ctx, { node: ROUTE_NODE.membership, kind: "event", label: `Stale by membership: ${marked.length} page(s)`, lit: { pages: marked } });
  return marked;
}

/** Route 2 (flagged at filing): the filing call said "this updates / contradicts X": every page about X. */
export async function staleByFlag(ctx: RunCtx, brickId: string, reason: string, rootId: string): Promise<string[]> {
  const pages = new Set(await pagesContaining(ctx, "brick", brickId));
  const brick = await getBrick(ctx, brickId);
  if (brick) for (const p of await mentioning(ctx, brick)) pages.add(p);
  const marked: string[] = [];
  for (const p of pages) if (await markStale(ctx, p, "flagged", reason, rootId)) marked.push(p);
  if (marked.length) await logStep(ctx, { node: ROUTE_NODE.flagged, kind: "event", label: `Stale by a flagged update: ${marked.length} page(s)`, lit: { pages: marked, bricks: [brickId] } });
  return marked;
}

async function mentioning(ctx: Ctx, brick: Brick): Promise<string[]> {
  const out = new Set<string>();
  if (brick.name.length >= 4) {
    const r = await ctx.db.query<{ id: string; body: string }>(`SELECT id, body FROM pages WHERE user_id=$1 AND archived_at IS NULL AND body ILIKE $2`, [ctx.userId, `%${brick.name}%`]);
    for (const row of r.rows) if (!row.body.includes(`[[b:${brick.id}`)) out.add(row.id);
  }
  const { hits, model } = await similarTo(ctx, `${brick.name}. ${brick.summary}`, { kinds: ["page"], limit: 4 });
  for (const h of hits) if (h.score > (model.startsWith("local") ? 0.55 : 0.8)) out.add(h.id);
  return [...out];
}

/** Route 3 (mentions): pages that name the changed brick, or are close in meaning, without citing it. */
export async function staleByMention(ctx: RunCtx, brickIds: string[], reason: string, rootId: string): Promise<string[]> {
  const marked: string[] = [];
  for (const id of brickIds) {
    const brick = await getBrick(ctx, id);
    if (!brick || brick.kind === "source") continue;
    const cited = new Set(await pagesContaining(ctx, "brick", id));
    for (const p of await mentioning(ctx, brick)) if (!cited.has(p) && (await markStale(ctx, p, "mention", `${reason} (mentions ${brick.name})`, rootId))) marked.push(p);
  }
  if (marked.length) await logStep(ctx, { node: ROUTE_NODE.mention, kind: "event", label: `Stale by mention: ${marked.length} page(s)`, lit: { pages: marked } });
  return marked;
}

/** Route 4 (time): dated entries that have passed. */
export async function staleByTime(ctx: RunCtx): Promise<string[]> {
  const r = await ctx.db.query<{ id: string; brick_id: string; text: string }>(`SELECT id, brick_id, text FROM entries WHERE user_id=$1 AND archived_at IS NULL AND status='open' AND due_at IS NOT NULL AND due_at < $2`, [ctx.userId, ctx.now().toISOString()]);
  const marked: string[] = [];
  for (const e of r.rows) {
    for (const p of await pagesContaining(ctx, "brick", e.brick_id)) if (await markStale(ctx, p, "time", `A date passed: ${e.text.slice(0, 120)}`, `time:${e.id}`)) marked.push(p);
  }
  await logStep(ctx, { node: ROUTE_NODE.time, kind: "event", label: `Dates passed: ${r.rows.length} entr${r.rows.length === 1 ? "y" : "ies"}, ${marked.length} page(s) marked`, lit: { pages: marked } });
  return marked;
}

/** Route 5 (spot-checks): a few random older pages a day, reread against their bricks. */
export async function spotChecks(ctx: RunCtx): Promise<string[]> {
  const day = ctx.now().toISOString().slice(0, 10);
  if ((await getMeta(ctx, `spotcheck:${ctx.userId}`)) === day) return [];
  await setMeta(ctx, `spotcheck:${ctx.userId}`, day);
  const pages = (await listPages(ctx)).filter((p) => p.kind !== "guide" && ctx.now().getTime() - new Date(p.updatedAt).getTime() > 2 * 86_400_000);
  const picked = pages.sort(() => Math.random() - 0.5).slice(0, KNOBS.spotChecksPerDay);
  const marked: string[] = [];
  for (const p of picked) if (await markStale(ctx, p.id, "spotcheck", "A random spot-check: reread against its bricks", `spot:${day}:${p.id}`)) marked.push(p.id);
  await logStep(ctx, { node: ROUTE_NODE.spotcheck, kind: "event", label: `Spot-checks: ${marked.length} page(s)`, lit: { pages: marked } });
  return marked;
}

/** Route 6 (Isaak): anything he revises, top priority. */
export async function staleByIsaak(ctx: RunCtx, pageId: string, hisText: string, revisionId: string): Promise<void> {
  await markStale(ctx, pageId, "isaak", `Isaak: ${hisText}`, `isaak:${revisionId}`);
  await logStep(ctx, { node: ROUTE_NODE.isaak, kind: "event", label: "Your revision marked the page stale (top priority)", lit: { pages: [pageId] } });
}

const mapMark = (r: Record<string, unknown>): StaleMark => ({ id: String(r.id), pageId: String(r.page_id), route: String(r.route) as Route, reason: String(r.reason), rootId: String(r.root_id), triage: r.triage == null ? null : String(r.triage), triageWhy: String(r.triage_why ?? ""), at: iso(r.at) });

/** The stale queue, by importance: Isaak first, then pages near the life document, then recently used. */
export async function staleQueue(ctx: Ctx): Promise<StaleMark[]> {
  const r = await ctx.db.query(`SELECT * FROM stale_marks WHERE user_id=$1 AND done_at IS NULL AND archived_at IS NULL ORDER BY at`, [ctx.userId]);
  const marks = r.rows.map(mapMark);
  const life = await lifeDocument(ctx);
  const nearLife = new Set<string>(life ? [life.id, ...(await members(ctx, life.id)).filter((m) => m.kind === "page").map((m) => m.id)] : []);
  const pages = new Map((await listPages(ctx)).map((p) => [p.id, p]));
  const score = (m: StaleMark) => (m.route === "isaak" ? 1000 : 0) + (nearLife.has(m.pageId) ? 100 : 0) + (pages.get(m.pageId)?.lastUsedAt ? 10 + new Date(pages.get(m.pageId)!.lastUsedAt!).getTime() / 1e13 : 0);
  return marks.sort((a, b) => score(b) - score(a));
}

async function finishMark(ctx: Ctx, markId: string, triage: "yes" | "no" | "skip", why: string): Promise<void> {
  await ctx.db.query(`UPDATE stale_marks SET triage=$3, triage_why=$4, done_at=$5 WHERE user_id=$1 AND id=$2`, [ctx.userId, markId, triage, why.slice(0, 500), ctx.now().toISOString()]);
}

async function rewrittenToday(ctx: Ctx, pageId: string, rootId: string): Promise<boolean> {
  const day = ctx.now().toISOString().slice(0, 10);
  const r = await ctx.db.query<{ reason_chain: string; at: unknown }>(`SELECT reason_chain, at FROM page_versions WHERE user_id=$1 AND page_id=$2`, [ctx.userId, pageId]);
  const n = r.rows.filter((v) => iso(v.at).slice(0, 10) === day && String(v.reason_chain).includes(rootId)).length;
  return n >= KNOBS.rewritesPerPagePerRootPerDay;
}

/** What changed, for the triage and the rewrite: the page's members in full. */
async function changedMaterial(ctx: Ctx, page: Page): Promise<string> {
  const parts: string[] = [];
  let used = 0;
  for (const m of await members(ctx, page.id)) {
    const text = await render(ctx, { kind: m.kind as "brick", id: m.id });
    used += text.length;
    if (used > 30_000) break;
    parts.push(text);
  }
  return parts.join("\n\n");
}

/**
 * Work through the stale queue: triage each mark, rewrite where it matters, pass staleness up only when a claim changed.
 * Pauses (saving where it was) when Isaak speaks.
 */
export async function workStaleQueue(ctx: RunCtx, max = 8): Promise<{ triaged: number; rewritten: number }> {
  const queue = await staleQueue(ctx);
  await logStep(ctx, { node: "upkeep/squeue", kind: "event", label: `Stale queue: ${queue.length} mark(s), most important first`, detail: { backlog: queue.length } });
  let triaged = 0;
  let rewritten = 0;
  const system = await systemPrompt(ctx);
  const byPage = new Map<string, StaleMark[]>();
  for (const m of queue) byPage.set(m.pageId, [...(byPage.get(m.pageId) ?? []), m]);
  for (const [pageId, marks] of [...byPage.entries()].slice(0, max)) {
    await checkpoint(ctx, () => ({ stage: "stale", done: triaged }));
    const page = await getPage(ctx, pageId);
    if (!page) { for (const m of marks) await finishMark(ctx, m.id, "skip", "page archived"); continue; }
    const mark = marks[0];
    if (mark.route !== "isaak" && (await rewrittenToday(ctx, pageId, mark.rootId))) {
      await logStep(ctx, { node: "upkeep/once", kind: "event", label: `Already rewritten today for this cause: "${page.title}"` });
      for (const m of marks) await finishMark(ctx, m.id, "skip", "already rewritten today for this root cause");
      continue;
    }
    const reasons = marks.map((m) => `- (${m.route}) ${m.reason}`).join("\n");
    const material = await changedMaterial(ctx, page);
    const triage = await timed(ctx, "upkeep/triage", "call", `Triage: "${page.title}"`, () => ctx.ai.call({
      task: "triage", tier: "fast", json: true, system,
      prompt: `TASK: triage\nA page in your memory was marked stale. Does this change matter for this page? Answer yes or no, with one line why.\n\nPAGE [[p:${page.id}]] "${page.title}" (purpose: ${page.purpose})\n${page.body}\n\nWHY IT WAS MARKED\n${reasons}\n\nWHAT IT IS MADE OF NOW\n${material}\n\nReturn JSON {"matters": true|false, "why": "..."}`,
    }), (r) => ({ model: r.model, charsIn: r.charsIn, charsOut: r.charsOut, lit: { pages: [pageId] } }));
    triaged += 1;
    let verdict: { matters?: boolean; why?: string } = {};
    try { verdict = extractJson(triage.text) as typeof verdict; } catch { verdict = { matters: /\byes\b/i.test(triage.text), why: triage.text.slice(0, 200) }; }
    if (!verdict.matters && mark.route !== "isaak") {
      for (const m of marks) await finishMark(ctx, m.id, "no", verdict.why ?? "");
      await ctx.db.query(`UPDATE pages SET status='fresh', reviewed_at=$3 WHERE user_id=$1 AND id=$2`, [ctx.userId, pageId, ctx.now().toISOString()]);
      await logStep(ctx, { node: "upkeep/no", kind: "event", label: `No: "${page.title}" — ${verdict.why ?? ""}`.slice(0, 300) });
      continue;
    }
    await checkpoint(ctx, () => ({ stage: "stale", done: triaged }));
    const rewrite = await timed(ctx, "upkeep/rewrite", "call", `Rewrite: "${page.title}"`, () => ctx.ai.call({
      task: "rewrite", tier: "main", json: true, system,
      prompt: `TASK: rewrite\nRewrite this page of your memory so it is true to what it is made of. Keep what still holds; change what the reasons below change. Cite with [[b:id]] [[p:id]] [[s:id]] (only ids shown here). Label guesses as guesses. Do not psychologise Isaak.\n\nPAGE [[p:${page.id}]] "${page.title}" (purpose: ${page.purpose}; version ${page.version})\n${page.body}\n\nWHY\n${reasons}\n\nWHAT IT IS MADE OF NOW\n${material}\n\nReturn JSON {"body": "...", "change_note": "what changed and why, one or two lines", "claim_changed": true|false}`,
    }), (r) => ({ model: r.model, charsIn: r.charsIn, charsOut: r.charsOut, lit: { pages: [pageId] } }));
    let out: { body?: string; change_note?: string; claim_changed?: boolean } = {};
    try { out = extractJson(rewrite.text) as typeof out; } catch { out = {}; }
    if (!out.body) {
      for (const m of marks) await finishMark(ctx, m.id, "yes", `rewrite returned no body: ${verdict.why ?? ""}`);
      await logStep(ctx, { node: "upkeep/rewrite", kind: "event", label: "The rewrite came back without a body; the page is left as it was", ok: false });
      continue;
    }
    try {
      await revisePage(ctx, pageId, { body: out.body, changeNote: out.change_note ?? "", claimChanged: Boolean(out.claim_changed), reasonChain: marks.map((m) => m.rootId) });
    } catch (error) {
      for (const m of marks) await finishMark(ctx, m.id, "yes", `rewrite refused by code: ${(error as Error).message}`);
      await logStep(ctx, { node: "upkeep/rewrite", kind: "event", label: `Code refused the rewrite: ${(error as Error).message}`.slice(0, 300), ok: false });
      continue;
    }
    rewritten += 1;
    for (const m of marks) await finishMark(ctx, m.id, "yes", verdict.why ?? "");
    await logStep(ctx, { node: "upkeep/claim", kind: "event", label: out.claim_changed ? `A claim changed in "${page.title}"` : `No claim changed in "${page.title}"`, detail: { change_note: out.change_note } });
    if (out.claim_changed) {
      const parents = await pagesContaining(ctx, "page", pageId);
      for (const parent of parents) await markStale(ctx, parent, "membership", `"${page.title}" changed a claim: ${out.change_note ?? ""}`, marks[0].rootId);
      await logStep(ctx, { node: parents.length ? "upkeep/up" : "upkeep/stop", kind: "event", label: parents.length ? `Parent page(s) marked: ${parents.length}` : "No page above: the ripple stops", lit: { pages: parents } });
    } else {
      await logStep(ctx, { node: "upkeep/stop", kind: "event", label: "Nothing that matters changed above: the branch stops" });
    }
  }
  return { triaged, rewritten };
}

// ---------- candidates offered by code ----------

export interface Candidates { duplicates: { a: string; b: string; why: string }[]; islands: string[][]; thinCentral: { id: string; reach: number; depth: number }[]; noPage: string[][] }

/** Likely duplicates, islands, thin-but-central bricks, clusters with no page. Code offers; the model decides. */
export async function candidates(ctx: Ctx): Promise<Candidates> {
  const bricks = (await listBricks(ctx)).filter((b) => b.kind !== "source");
  const links = (await ctx.db.query<{ a: string; b: string }>(`SELECT a, b FROM links WHERE user_id=$1 AND archived_at IS NULL`, [ctx.userId])).rows;
  const ids = new Set(bricks.map((b) => b.id));
  const adj = new Map<string, Set<string>>();
  for (const l of links) {
    if (!ids.has(l.a) || !ids.has(l.b)) continue;
    adj.set(l.a, (adj.get(l.a) ?? new Set()).add(l.b));
    adj.set(l.b, (adj.get(l.b) ?? new Set()).add(l.a));
  }
  // duplicates: same words in the name
  const duplicates: Candidates["duplicates"] = [];
  const key = (n: string) => words(n).sort().join(" ");
  const byKey = new Map<string, Brick[]>();
  for (const b of bricks) { const k = key(b.name); if (k) byKey.set(k, [...(byKey.get(k) ?? []), b]); }
  for (const group of byKey.values()) for (let i = 1; i < group.length; i += 1) duplicates.push({ a: group[0].id, b: group[i].id, why: `same words in the name: "${group[0].name}" / "${group[i].name}"` });
  // connected parts
  const seen = new Set<string>();
  const comps: string[][] = [];
  for (const b of bricks) {
    if (seen.has(b.id)) continue;
    const comp: string[] = [];
    const stack = [b.id];
    seen.add(b.id);
    while (stack.length) { const x = stack.pop()!; comp.push(x); for (const y of adj.get(x) ?? []) if (!seen.has(y)) { seen.add(y); stack.push(y); } }
    comps.push(comp);
  }
  const biggest = Math.max(0, ...comps.map((c) => c.length));
  const islands = comps.filter((c) => c.length >= 2 && c.length < biggest && c.length <= 12);
  // reach vs depth
  const entryCounts = new Map((await ctx.db.query<{ brick_id: string; n: string }>(`SELECT brick_id, count(*) AS n FROM entries WHERE user_id=$1 AND archived_at IS NULL GROUP BY brick_id`, [ctx.userId])).rows.map((r) => [r.brick_id, Number(r.n)]));
  const life = await lifeDocument(ctx);
  const thinCentral = bricks
    .map((b) => ({ id: b.id, reach: (adj.get(b.id)?.size ?? 0) + (life?.body.includes(b.name) ? 3 : 0) + (b.lastUsedAt ? 2 : 0), depth: entryCounts.get(b.id) ?? 0 }))
    .filter((x) => x.reach >= 5 && x.depth <= 2)
    .sort((a, b) => b.reach - a.reach)
    .slice(0, 10);
  const inPage = new Set((await ctx.db.query<{ member_id: string }>(`SELECT member_id FROM page_members WHERE user_id=$1 AND member_kind='brick' AND archived_at IS NULL`, [ctx.userId])).rows.map((r) => r.member_id));
  const noPage = comps.filter((c) => c.length >= 3 && c.filter((x) => !inPage.has(x)).length >= 3).map((c) => c.filter((x) => !inPage.has(x)).slice(0, 20)).slice(0, 6);
  return { duplicates: duplicates.slice(0, 20), islands: islands.slice(0, 10), thinCentral, noPage };
}

export async function backlog(ctx: Ctx): Promise<number> {
  const r = await ctx.db.query<{ n: string }>(`SELECT count(DISTINCT page_id) AS n FROM stale_marks WHERE user_id=$1 AND done_at IS NULL AND archived_at IS NULL`, [ctx.userId]);
  return Number(r.rows[0]?.n ?? 0);
}
