import { guardSearchQuery } from "../privacy.js";
import { embedOwners, similarTo, words } from "./embed.js";
import { getPage, members, pagesContaining } from "./pages.js";
import { addSource, getBrick, getSource, linksOf, listEntries, type Brick } from "./store.js";
import type { Ctx } from "./steps.js";

/**
 * The looking hands (BUILD_SPEC §5.6–5.7): find (words), similar (meaning), near (links, strongest first), open (in full),
 * web (the internet). They return references, never copies: a pack stores ids and character ranges (§4 packs).
 */
export interface Ref { kind: "brick" | "page" | "source" | "web" | "map" | "code"; id: string; range?: [number, number]; why?: string; title?: string; score?: number }

const label = (kind: string) => (kind === "brick" ? "b" : kind === "page" ? "p" : "s");

export async function find(ctx: Ctx, query: string, limit = 12): Promise<Ref[]> {
  const terms = [...new Set(words(query))].sort((a, b) => b.length - a.length).slice(0, 4);
  if (!terms.length) return [];
  const like = terms.map((t) => `%${t}%`);
  const score = (text: string) => terms.reduce((s, t) => s + (text.toLowerCase().includes(t) ? 1 : 0), 0);
  const out: Ref[] = [];
  const bricks = await ctx.db.query(`SELECT id, name, summary FROM bricks WHERE user_id=$1 AND archived_at IS NULL AND (name ILIKE ANY($2::text[]) OR summary ILIKE ANY($2::text[]))`, [ctx.userId, like]);
  for (const b of bricks.rows) out.push({ kind: "brick", id: String(b.id), title: String(b.name), score: score(`${b.name} ${b.summary}`) + 1 });
  const entries = await ctx.db.query(`SELECT DISTINCT e.brick_id, b.name, e.text FROM entries e JOIN bricks b ON b.id=e.brick_id WHERE e.user_id=$1 AND e.archived_at IS NULL AND b.archived_at IS NULL AND e.text ILIKE ANY($2::text[]) LIMIT 60`, [ctx.userId, like]);
  for (const e of entries.rows) out.push({ kind: "brick", id: String(e.brick_id), title: String(e.name), score: score(String(e.text)) });
  const pages = await ctx.db.query(`SELECT id, title, purpose, body FROM pages WHERE user_id=$1 AND archived_at IS NULL AND (title ILIKE ANY($2::text[]) OR body ILIKE ANY($2::text[]) OR purpose ILIKE ANY($2::text[]))`, [ctx.userId, like]);
  for (const p of pages.rows) out.push({ kind: "page", id: String(p.id), title: String(p.title), score: score(`${p.title} ${p.purpose} ${String(p.body).slice(0, 4000)}`) + 0.5 });
  const sources = await ctx.db.query(`SELECT id, title, body FROM sources WHERE user_id=$1 AND archived_at IS NULL AND (title ILIKE ANY($2::text[]) OR body ILIKE ANY($2::text[])) LIMIT 30`, [ctx.userId, like]);
  for (const s of sources.rows) {
    const body = String(s.body);
    const at = terms.map((t) => body.toLowerCase().indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    out.push({ kind: "source", id: String(s.id), title: String(s.title), range: [Math.max(0, at - 1200), Math.min(body.length, at + 1800)], score: score(`${s.title} ${body.slice(0, 20000)}`) });
  }
  return dedupe(out).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
}

export async function similar(ctx: Ctx, query: string, limit = 10): Promise<{ refs: Ref[]; note?: string; model: string }> {
  const { hits, note, model } = await similarTo(ctx, query, { limit });
  const refs: Ref[] = [];
  for (const h of hits) {
    if (h.kind === "chunk") {
      const [sourceId, start, end] = h.id.split(":");
      refs.push({ kind: "source", id: sourceId, range: [Number(start), Number(end)], score: h.score });
    } else refs.push({ kind: h.kind as Ref["kind"], id: h.id, score: h.score });
  }
  return { refs: dedupe(refs), note, model };
}

/**
 * What is directly linked to a brick or page, strongest first: judged links, then the computed relations
 * (same source, same page, shared distinctive words, similar meaning). Computed relations are views, not rows.
 */
export async function near(ctx: Ctx, nodeId: string, limit = 12): Promise<Ref[]> {
  const out: Ref[] = [];
  for (const l of await linksOf(ctx, nodeId)) out.push({ kind: await kindOf(ctx, l.a === nodeId ? l.b : l.a), id: l.a === nodeId ? l.b : l.a, why: `${l.relation}: ${l.reason}`.slice(0, 160), score: 10 + l.strength });
  const relations = await computedRelations(ctx, nodeId);
  out.push(...relations);
  return dedupe(out.filter((r) => r.id !== nodeId)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
}

async function kindOf(ctx: Ctx, nodeId: string): Promise<Ref["kind"]> {
  const r = await ctx.db.query(`SELECT 1 FROM pages WHERE user_id=$1 AND id=$2`, [ctx.userId, nodeId]);
  return r.rows.length ? "page" : "brick";
}

export async function computedRelations(ctx: Ctx, nodeId: string): Promise<Ref[]> {
  const out: Ref[] = [];
  const brick = await getBrick(ctx, nodeId);
  if (brick) {
    const sameSource = await ctx.db.query(`SELECT DISTINCT e2.brick_id FROM entries e1 JOIN entries e2 ON e1.source_id=e2.source_id AND e2.brick_id<>e1.brick_id WHERE e1.user_id=$1 AND e1.brick_id=$2 AND e1.source_id IS NOT NULL AND e2.archived_at IS NULL LIMIT 20`, [ctx.userId, nodeId]);
    for (const r of sameSource.rows) out.push({ kind: "brick", id: String(r.brick_id), why: "same source", score: 3 });
    for (const pageId of await pagesContaining(ctx, "brick", nodeId)) {
      out.push({ kind: "page", id: pageId, why: "a page it is part of", score: 4 });
      for (const m of await members(ctx, pageId)) if (m.kind === "brick") out.push({ kind: "brick", id: m.id, why: "same page", score: 2.5 });
    }
    const shared = await sharedWords(ctx, brick);
    out.push(...shared);
    const { hits } = await similarTo(ctx, `${brick.name}. ${brick.summary}`, { limit: 6, kinds: ["brick"], exclude: [nodeId] });
    for (const h of hits) out.push({ kind: "brick", id: h.id, why: `similar meaning (${h.score.toFixed(2)})`, score: 2 + h.score });
  } else {
    for (const m of await members(ctx, nodeId)) out.push({ kind: m.kind as Ref["kind"], id: m.id, why: "member", score: 5 });
    for (const p of await pagesContaining(ctx, "page", nodeId)) out.push({ kind: "page", id: p, why: "inside this page", score: 4 });
  }
  return out;
}

/** Distinctive words in common: words rare across the web (in at most 3 other bricks) that both names or summaries use. */
async function sharedWords(ctx: Ctx, brick: Brick): Promise<Ref[]> {
  const mine = [...new Set(words(`${brick.name} ${brick.summary}`))].filter((w) => w.length > 3).slice(0, 8);
  if (!mine.length) return [];
  const out: Ref[] = [];
  for (const w of mine) {
    const r = await ctx.db.query(`SELECT id FROM bricks WHERE user_id=$1 AND archived_at IS NULL AND id<>$2 AND (name ILIKE $3 OR summary ILIKE $3) LIMIT 4`, [ctx.userId, brick.id, `%${w}%`]);
    if (r.rows.length > 3) continue;
    for (const row of r.rows) out.push({ kind: "brick", id: String(row.id), why: `shared word "${w}"`, score: 2.2 });
  }
  return out;
}

export async function web(ctx: Ctx & { runId?: string }, query: string, privateFragments: string[] = []): Promise<{ ref: Ref | null; blocked?: string; text: string; model: string }> {
  const guard = guardSearchQuery(query, privateFragments);
  if (!guard.ok) return { ref: null, blocked: guard.reason, text: `Search refused by code (${guard.reason}): private details never go into a web search.`, model: "" };
  const result = await ctx.ai.call({
    task: "web",
    tier: "fast",
    webSearch: true,
    system: "TASK: web\nSearch the web for the query. Read the best pages in full. Report what they say, plainly, with the facts that matter, and say where sources disagree. Never invent a source.",
    prompt: `Query: ${guard.query}`,
  });
  const { source, brickId } = await addSource(ctx, { kind: "web", title: `Web: ${guard.query}`, body: result.text, filed: false });
  void brickId;
  await embedOwners(ctx, [{ kind: "chunk", id: `${source.id}:0:${Math.min(result.text.length, 6000)}`, text: result.text.slice(0, 6000) }]);
  return { ref: { kind: "source", id: source.id, title: source.title, why: "web search" }, text: result.text, model: result.model };
}

function dedupe(refs: Ref[]): Ref[] {
  const seen = new Map<string, Ref>();
  for (const r of refs) {
    const key = `${r.kind}:${r.id}`;
    const prev = seen.get(key);
    if (!prev || (r.score ?? 0) > (prev.score ?? 0)) seen.set(key, { ...prev, ...r, why: prev?.why && r.why && prev.why !== r.why ? `${prev.why}; ${r.why}` : r.why ?? prev?.why });
  }
  return [...seen.values()];
}

/** The text a reference stands for, as the model reads it. Citations in the text use the ids it may cite. */
export async function render(ctx: Ctx, ref: Ref): Promise<string> {
  if (ref.kind === "brick") {
    const b = await getBrick(ctx, ref.id);
    if (!b) return "";
    const entries = await listEntries(ctx, b.id);
    const links = await linksOf(ctx, b.id);
    const names = new Map<string, string>();
    for (const l of links.slice(0, 12)) {
      const other = l.a === b.id ? l.b : l.a;
      const ob = await getBrick(ctx, other);
      names.set(other, ob?.name ?? (await getPage(ctx, other))?.title ?? other);
    }
    return [
      `[[b:${b.id}]] ${b.name} (${b.kind}; ${b.corner === "own" ? "its own corner" : "about Isaak's life"}${b.sourceId ? `; source [[s:${b.sourceId}]]` : ""})${b.summary ? ` — ${b.summary}` : ""}`,
      ...entries.slice(-25).map((e) => `  - ${e.kind}${e.origin !== "his" ? ` (${e.origin === "own" ? "its own note, not evidence" : "from the web"})` : ""}${e.status !== "open" ? ` [${e.status}]` : ""}: ${e.text}${e.quote ? ` — "${e.quote.slice(0, 240)}"` : ""}${e.sourceId ? ` [[s:${e.sourceId}]]` : ""}${e.dueAt ? ` (due ${e.dueAt.slice(0, 10)})` : ""}`),
      ...links.slice(0, 12).map((l) => `  ~ ${l.relation} → [[${label("brick")}:${l.a === b.id ? l.b : l.a}]] ${names.get(l.a === b.id ? l.b : l.a)}: ${l.reason}`),
    ].join("\n");
  }
  if (ref.kind === "page") {
    const p = await getPage(ctx, ref.id);
    if (!p) return "";
    return `[[p:${p.id}]] PAGE "${p.title}" (${p.kind}, v${p.version}, ${p.status})\nPurpose: ${p.purpose}\n${p.body}`;
  }
  if (ref.kind === "source" || ref.kind === "web") {
    const s = await getSource(ctx, ref.id);
    if (!s) return "";
    const [a, z] = ref.range ?? [0, Math.min(s.body.length, 12000)];
    return `[[s:${s.id}]] SOURCE "${s.title}" (${s.kind}; characters ${a}–${z} of ${s.body.length})\n${s.body.slice(a, z)}`;
  }
  return "";
}
