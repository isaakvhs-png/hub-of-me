import { extractJson } from "../json.js";
import { KNOBS } from "../knobs.js";
import { embedOwners, similarTo, words } from "./embed.js";
import { findPageByTitle, pagesContaining, getPage } from "./pages.js";
import { systemPrompt } from "./prompts.js";
import {
  addEntry, addLink, addStream, createBrick, findBrickByName, getBrick, listBricks, listEntries, setSourceFiled, sourceBrickId, supersede, touchBricks,
  type Brick, type SourceRow, type StreamRow,
} from "./store.js";
import { logStep, timed, type RunCtx } from "./steps.js";
import { staleByFlag, staleByMembership, staleByMention } from "./upkeep.js";
import { addGoal, addRequestOrEvidence, listGoals } from "./workshop.js";
import { enqueue } from "./queue.js";

/**
 * Intake (BUILD_SPEC §5.2): how a source becomes bricks, entries with quotes, and judged links.
 * Files are filed at once; the conversation in batches when Isaak goes quiet. One filing call per part; it reads its
 * guide "How I file", the framing, the index of every brick, and the part. Code stores, finds every quote's position,
 * marks what was superseded and what is stale, and writes an intake digest for the reply run.
 */

export function splitParts(text: string, size = KNOBS.filingPartChars): { text: string; start: number }[] {
  const parts: { text: string; start: number }[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const para = text.lastIndexOf("\n\n", end);
      const line = text.lastIndexOf("\n", end);
      const cut = para > start + size * 0.4 ? para : line > start + size * 0.4 ? line : end;
      end = cut;
    }
    const piece = text.slice(start, end);
    if (piece.trim()) parts.push({ text: piece, start });
    start = end;
    while (text[start] === "\n") start += 1;
  }
  return parts;
}

/** The index of every brick, one line each. Read whole while under the knob; beyond that pre-selected by words and meaning. */
export async function brickIndex(ctx: RunCtx, partText: string): Promise<{ text: string; ids: Set<string>; whole: boolean; total: number }> {
  const bricks = await listBricks(ctx);
  const line = (b: Brick) => `${b.id} | ${b.name} | ${b.kind} | ${b.corner} | ${b.summary.slice(0, 90)}`;
  const all = bricks.map(line).join("\n");
  if (all.length <= KNOBS.brickIndexWholeUnderChars) return { text: all || "(no bricks yet: everything is new)", ids: new Set(bricks.map((b) => b.id)), whole: true, total: bricks.length };
  const want = new Set<string>();
  const terms = new Set(words(partText));
  for (const b of bricks) if (words(b.name).some((w) => terms.has(w))) want.add(b.id);
  const { hits } = await similarTo(ctx, partText.slice(0, 4000), { kinds: ["brick"], limit: 150 });
  for (const h of hits) want.add(h.id);
  for (const b of [...bricks].sort((a, z) => z.updatedAt.localeCompare(a.updatedAt)).slice(0, 100)) want.add(b.id);
  const chosen = bricks.filter((b) => want.has(b.id));
  let text = "";
  const ids = new Set<string>();
  for (const b of chosen) { const l = line(b); if (text.length + l.length > KNOBS.brickIndexWholeUnderChars) break; text += `${l}\n`; ids.add(b.id); }
  return { text: `${text}(pre-selected ${ids.size} of ${bricks.length} bricks by shared words, meaning and recency)`, ids, whole: false, total: bricks.length };
}

interface Filed {
  things?: { ref?: string; name?: string; kind?: string; summary?: string; corner?: string; entries?: { kind?: string; text?: string; quote?: string; due?: string; said_by?: string }[] }[];
  links?: { a?: string; b?: string; relation?: string; reason?: string }[];
  updates?: { brick?: string; replaces?: string; now?: string }[];
  note?: { doubts?: ({ text?: string; bricks?: string[] } | string)[]; missed?: string[] };
}

export interface Digest {
  sources: { id: string; title: string; parts: number; failed: number }[];
  themes: Record<string, { new: string[]; updated: string[]; islands: string[] }>;
  newBricks: string[];
  touched: string[];
  superseded: number;
  contradictions: string[];
  doubts: string[];
}

export const emptyDigest = (): Digest => ({ sources: [], themes: {}, newBricks: [], touched: [], superseded: 0, contradictions: [], doubts: [] });

/** Find a quote in the source text (whitespace-insensitive). Returns its position, or null when the words aren't there. */
export function locate(haystack: string, quote: string, from = 0): [number, number] | null {
  const q = quote.trim();
  if (q.length < 3) return null;
  let at = haystack.indexOf(q, from);
  if (at < 0) at = haystack.indexOf(q);
  if (at >= 0) return [at, at + q.length];
  const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const m = new RegExp(pattern, "i").exec(haystack);
  return m ? [m.index, m.index + m[0].length] : null;
}

function filingPrompt(input: { guide: string; framing: string | null; index: string; part: string; label: string; conversation: boolean }): string {
  return `TASK: filing
You file what comes in into your web of bricks. One brick is one thing: a person, place, organisation, project, idea, question, event, plan, concept, feeling… Be granular: a page of notes gives 20 to 30 bricks.
For every thing the part mentions: use the id of a brick in THE INDEX when one already means it (a nickname or a longer name is the same thing); otherwise give a new brick a short name that could not be mistaken for another thing.
Entries are what the part says about each thing, in its meaning, with the exact words as the quote (copied, not paraphrased). Dated things get "due" (ISO date).
Links are the ones you judge: a relation and a reason (answers a need, supports, contradicts, causes, part of, involves, updates, insight, relevant to). Don't link what merely appears together.
Updates: when the part changes what a brick said (a corrected fact, a changed plan), say which brick, what it said before, and what is true now.
Corner: "own" when the thing is about you yourself or how you work (Isaak's questions about you included); "his" when it is about Isaak's life and work.
The filing note: your doubts (e.g. two different people with one name), and what you could not capture (a table flattened, an image you can't see).
${input.conversation ? 'This part is conversation between Isaak and you; for each entry say "said_by": "isaak" or "you". Your own words are your notes, never evidence about him.\n' : ""}
SELF-GUIDE "How I file":
${input.guide || "(empty so far: you write it as you learn)"}

${input.framing ? `FRAMING (Isaak's words sent with this file):\n${input.framing}\n\n` : ""}THE INDEX OF EVERY BRICK (id | name | kind | corner | summary):
${input.index}

THE PART (${input.label}):
${input.part}

Return one JSON object:
{"things":[{"ref":"<existing id, or omit>","name":"...","kind":"...","summary":"one line","corner":"his|own","entries":[{"kind":"fact|question|lead|idea|todo|plan|event|feeling|...","text":"...","quote":"exact words","due":"YYYY-MM-DD (only if dated)"${input.conversation ? ',"said_by":"isaak|you"' : ""}}]}],
 "links":[{"a":"<id or name>","b":"<id or name>","relation":"...","reason":"..."}],
 "updates":[{"brick":"<id or name>","replaces":"what it said before","now":"what is true now"}],
 "note":{"doubts":[{"text":"...","bricks":["<id or name>"]}],"missed":["..."]}}`;
}

async function guideBody(ctx: RunCtx, title: string): Promise<string> {
  const p = await findPageByTitle(ctx, title);
  return p?.kind === "guide" ? p.body : "";
}

/** The theme a brick sits in: the top page above it, or none yet. */
async function themeOf(ctx: RunCtx, brickId: string): Promise<string> {
  let pages = await pagesContaining(ctx, "brick", brickId);
  for (let depth = 0; depth < 6 && pages.length; depth += 1) {
    const up = await pagesContaining(ctx, "page", pages[0]);
    const life = up.length ? await getPage(ctx, up[0]) : null;
    if (!up.length || life?.kind === "life") return (await getPage(ctx, pages[0]))?.title ?? "no page yet";
    pages = up;
  }
  return "no page yet";
}

/** File one part. Returns what it touched. Failures are recorded and rethrown to the caller, which keeps the part for a retry. */
async function filePart(ctx: RunCtx, input: { part: string; partStart: number; label: string; source: SourceRow | null; sourceBody: string; framing: string | null; conversation: boolean; digest: Digest; before: Set<string> }): Promise<void> {
  const index = await timed(ctx, "intake/index", "event", "The index of every brick", () => brickIndex(ctx, input.part), (r) => ({ label: `The brick index: ${r.ids.size} of ${r.total} bricks${r.whole ? " (whole)" : " (pre-selected)"}`, charsOut: r.text.length }));
  const guide = await guideBody(ctx, "How I file");
  await logStep(ctx, { node: "intake/guideF", kind: "event", label: guide ? "Its self-guide 'How I file'" : "Its self-guide 'How I file' (empty so far)" });
  const system = await systemPrompt(ctx);
  const result = await timed(ctx, "intake/fcall/reads", "call", `Filing call: ${input.label}`, () => ctx.ai.call({
    task: "filing", tier: "main", json: true, system,
    prompt: filingPrompt({ guide, framing: input.framing, index: index.text, part: input.part, label: input.label, conversation: input.conversation }),
  }), (r) => ({ model: r.model, charsIn: r.charsIn, charsOut: r.charsOut, detail: r.fellBack ? { fellBack: r.fellBack } : undefined }));
  let filed: Filed;
  try { filed = extractJson(result.text) as Filed; } catch (error) { throw new Error(`The filing call's answer was not JSON: ${(error as Error).message}`); }

  const byName = new Map<string, Brick>();
  const resolve = async (refOrName: string | undefined): Promise<Brick | null> => {
    if (!refOrName) return null;
    const key = refOrName.trim();
    if (byName.has(key.toLowerCase())) return byName.get(key.toLowerCase())!;
    const direct = await getBrick(ctx, key);
    if (direct) return direct;
    return findBrickByName(ctx, key);
  };
  const touched = new Set<string>();
  const made: string[] = [];
  let entriesMade = 0;
  for (const thing of filed.things ?? []) {
    if (!thing.name && !thing.ref) continue;
    let brick = thing.ref && index.ids.has(thing.ref) ? await getBrick(ctx, thing.ref) : null;
    if (!brick && thing.ref) brick = await getBrick(ctx, thing.ref);
    if (!brick && thing.name) brick = await findBrickByName(ctx, thing.name);
    if (!brick) {
      brick = await createBrick(ctx, { name: thing.name ?? thing.ref ?? "unnamed", kind: thing.kind ?? "thing", summary: thing.summary ?? "", corner: thing.corner === "own" ? "own" : "his" });
      made.push(brick.id);
    } else if (thing.summary && !brick.summary) {
      // A summary is filled in once; after that bricks grow by entries, not by rewriting.
      await ctx.db.query(`UPDATE bricks SET summary=$3 WHERE user_id=$1 AND id=$2`, [ctx.userId, brick.id, thing.summary.slice(0, 400)]);
    }
    byName.set((thing.name ?? brick.name).toLowerCase(), brick);
    byName.set(brick.id, brick);
    touched.add(brick.id);
    for (const e of thing.entries ?? []) {
      if (!e.text) continue;
      const pos = e.quote && input.source ? locate(input.sourceBody, e.quote, input.partStart) : null;
      const due = e.due && !Number.isNaN(new Date(e.due).getTime()) ? new Date(e.due).toISOString() : null;
      await addEntry(ctx, { brickId: brick.id, kind: e.kind ?? "fact", text: e.text, origin: e.said_by === "you" ? "own" : input.source?.kind === "web" ? "web" : input.source?.kind === "own" ? "own" : "his", quote: e.quote ?? "", sourceId: input.source?.id ?? null, charStart: pos?.[0] ?? null, charEnd: pos?.[1] ?? null, dueAt: due });
      entriesMade += 1;
    }
  }
  await logStep(ctx, { node: "intake/fcall/things", kind: "event", label: `${touched.size} things: ${made.length} new, ${touched.size - made.length} existing`, lit: { bricks: [...touched] } });
  await logStep(ctx, { node: "intake/fcall/entries", kind: "event", label: `${entriesMade} entries with quotes` });

  // judged links
  let linked = 0;
  for (const l of filed.links ?? []) {
    const a = await resolve(l.a); const b = await resolve(l.b);
    if (!a || !b) continue;
    const link = await addLink(ctx, { a: a.id, b: b.id, relation: l.relation ?? "relevant to", reason: l.reason ?? "", madeBy: "filing" });
    if (!link) continue;
    linked += 1;
    touched.add(a.id); touched.add(b.id);
    if (/contradict/i.test(link.relation)) {
      input.digest.contradictions.push(`${a.name} ↔ ${b.name}: ${link.reason}`);
      await staleByFlag(ctx, input.before.has(a.id) ? a.id : b.id, `filing found a contradiction: ${link.reason}`, `contradiction:${link.id}`);
    }
  }
  await logStep(ctx, { node: "intake/fcall/jlinks", kind: "event", label: `${linked} judged link(s)` });

  // updates: the old entry is kept and marked superseded
  let superseded = 0;
  for (const u of filed.updates ?? []) {
    const brick = await resolve(u.brick);
    if (!brick || !u.now) continue;
    const entries = (await listEntries(ctx, brick.id)).filter((e) => e.status !== "superseded");
    const target = new Set(words(u.replaces ?? ""));
    const best = entries.map((e) => ({ e, score: words(e.text).filter((w) => target.has(w)).length })).sort((a, b) => b.score - a.score)[0];
    const fresh = await addEntry(ctx, { brickId: brick.id, kind: "update", text: u.now, origin: input.source?.kind === "own" ? "own" : "his", sourceId: input.source?.id ?? null, quote: "" });
    if (best && best.score > 0 && best.e.id !== fresh.id) { await supersede(ctx, best.e.id, fresh.id); superseded += 1; }
    touched.add(brick.id);
    await staleByFlag(ctx, brick.id, `an update: ${u.now}`.slice(0, 300), `update:${fresh.id}`);
  }
  input.digest.superseded += superseded;
  await logStep(ctx, { node: "intake/fcall/updates", kind: "event", label: `${(filed.updates ?? []).length} update(s)` });
  if (superseded) await logStep(ctx, { node: "intake/super", kind: "event", label: `${superseded} old entr${superseded === 1 ? "y" : "ies"} superseded (kept, marked)` });

  // the filing note
  const doubts = (filed.note?.doubts ?? []).map((d) => (typeof d === "string" ? { text: d, bricks: [] as string[] } : { text: d.text ?? "", bricks: d.bricks ?? [] })).filter((d) => d.text);
  for (const d of doubts) {
    input.digest.doubts.push(d.text);
    for (const ref of d.bricks) { const b = await resolve(ref); if (b) await addEntry(ctx, { brickId: b.id, kind: "doubt", text: d.text, origin: "own" }); }
  }
  for (const missed of filed.note?.missed ?? []) {
    await addRequestOrEvidence(ctx, { title: `Take in what filing can't capture: ${missed}`.slice(0, 160), kind: "intake", problem: `Filing ${input.label} could not capture: ${missed}` });
  }
  await logStep(ctx, { node: "intake/fcall/fnote", kind: "event", label: `Filing note: ${doubts.length} doubt(s), ${(filed.note?.missed ?? []).length} thing(s) it could not capture` });
  if (doubts.length || (filed.note?.missed ?? []).length) await logStep(ctx, { node: "intake/noteuse", kind: "event", label: "Doubts became open questions; what it couldn't capture became request evidence" });

  // code stores; vectors; stale routes; digest
  const touchedList = [...touched];
  await touchBricks(ctx, touchedList);
  const embedItems = [] as { kind: "brick" | "chunk"; id: string; text: string }[];
  for (const id of touchedList) { const b = await getBrick(ctx, id); if (b) embedItems.push({ kind: "brick", id, text: `${b.name}. ${b.summary}` }); }
  if (input.source) embedItems.push({ kind: "chunk", id: `${input.source.id}:${input.partStart}:${input.partStart + input.part.length}`, text: input.part });
  const embedded = await embedOwners(ctx, embedItems);
  await logStep(ctx, { node: "intake/stored", kind: "event", label: `Stored; quotes placed in the source; ${embedded.local + embedded.gemini} meaning vector(s)`, ok: !embedded.geminiError, detail: embedded.geminiError ? { geminiError: embedded.geminiError } : {}, lit: { bricks: touchedList, sources: input.source ? [input.source.id] : [] } });
  await logStep(ctx, { node: "intake/clinks", kind: "event", label: "Same source, shared words and similar meaning are computed when needed (not stored)" });
  await logStep(ctx, { node: "intake/touched", kind: "event", label: `${touchedList.length} brick(s) touched` });
  await staleByMembership(ctx, touchedList, `new material from ${input.label}`, `intake:${ctx.runId}`);
  await staleByMention(ctx, made, `new bricks from ${input.label}`, `intake:${ctx.runId}`);

  for (const id of touchedList) {
    const b = await getBrick(ctx, id);
    if (!b || b.kind === "source") continue;
    const theme = await themeOf(ctx, id);
    const t = (input.digest.themes[theme] ??= { new: [], updated: [], islands: [] });
    if (made.includes(id)) t.new.push(b.name); else if (!t.updated.includes(b.name)) t.updated.push(b.name);
  }
  input.digest.newBricks.push(...made);
  input.digest.touched.push(...touchedList.filter((t) => !input.digest.touched.includes(t)));
}

/** Islands: new bricks of this intake with no link to anything that existed before it. */
async function markIslands(ctx: RunCtx, digest: Digest, before: Set<string>): Promise<void> {
  for (const id of digest.newBricks) {
    const r = await ctx.db.query<{ a: string; b: string }>(`SELECT a, b FROM links WHERE user_id=$1 AND archived_at IS NULL AND (a=$2 OR b=$2)`, [ctx.userId, id]);
    if (r.rows.some((l) => before.has(l.a === id ? l.b : l.a))) continue;
    const b = await getBrick(ctx, id);
    if (!b) continue;
    const theme = Object.entries(digest.themes).find(([, t]) => t.new.includes(b.name))?.[0] ?? "no page yet";
    (digest.themes[theme] ??= { new: [], updated: [], islands: [] }).islands.push(b.name);
  }
}

/** File a whole source (a file, a web page, its own note). The framing is the message it came with. */
export async function fileSource(ctx: RunCtx, source: SourceRow, framing: string | null, digest: Digest, onlyParts?: number[]): Promise<void> {
  const before = new Set((await listBricks(ctx)).map((b) => b.id));
  const parts = splitParts(source.body);
  await logStep(ctx, { node: "intake/split", kind: "event", label: `"${source.title}": ${parts.length} part(s) of at most ${KNOBS.filingPartChars} characters`, lit: { sources: [source.id] } });
  if (framing) {
    const brickId = await sourceBrickId(ctx, source.id);
    if (brickId) await addEntry(ctx, { brickId, kind: "framing", text: "What Isaak said when he sent it", quote: framing, origin: "his" });
    await logStep(ctx, { node: "sources/sentwith", kind: "event", label: "Sent together: his words became the file's framing" });
  }
  const failed: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (onlyParts && !onlyParts.includes(i)) continue;
    try {
      await filePart(ctx, { part: parts[i].text, partStart: parts[i].start, label: `part ${i + 1} of ${parts.length} of "${source.title}", characters ${parts[i].start}–${parts[i].start + parts[i].text.length}`, source, sourceBody: source.body, framing, conversation: false, digest, before });
    } catch (error) {
      failed.push(String(i));
      await logStep(ctx, { node: "intake/retry", kind: "event", label: `Part ${i + 1} failed and is kept for a retry: ${(error as Error).message}`.slice(0, 300), ok: false });
    }
  }
  await setSourceFiled(ctx, source.id, failed);
  await markIslands(ctx, digest, before);
  digest.sources.push({ id: source.id, title: source.title, parts: parts.length, failed: failed.length });
}

/** File the conversation in one batch (one stretch of dialogue per call), once Isaak has gone quiet. */
export async function fileConversation(ctx: RunCtx, rows: StreamRow[]): Promise<Digest> {
  const digest = emptyDigest();
  if (!rows.length) return digest;
  const before = new Set((await listBricks(ctx)).map((b) => b.id));
  const text = rows.map((r) => `${r.kind === "his" ? "ISAAK" : "YOU"} (${r.at.slice(0, 16)}): ${r.content}`).join("\n\n");
  const parts = splitParts(text);
  await logStep(ctx, { node: "intake/split", kind: "event", label: `The conversation since the last filing: ${rows.length} message(s), ${parts.length} part(s)` });
  let ok = true;
  for (let i = 0; i < parts.length; i += 1) {
    try {
      await filePart(ctx, { part: parts[i].text, partStart: parts[i].start, label: `conversation, part ${i + 1} of ${parts.length}`, source: null, sourceBody: text, framing: null, conversation: true, digest, before });
    } catch (error) {
      ok = false;
      await logStep(ctx, { node: "intake/retry", kind: "event", label: `A conversation part failed; it stays unfiled for the next batch: ${(error as Error).message}`.slice(0, 300), ok: false });
    }
  }
  if (ok) await ctx.db.query(`UPDATE stream SET filed_at=$2 WHERE user_id=$1 AND id = ANY($3::text[])`, [ctx.userId, ctx.now().toISOString(), rows.map((r) => r.id)]);
  await markIslands(ctx, digest, before);
  if (digest.contradictions.length) {
    // A contradiction found after the reply was given: one follow-up line in the chat.
    await addStream(ctx, { kind: "its", content: `While filing our conversation I noticed something that doesn't fit: ${digest.contradictions[0]}`, runId: ctx.runId });
  }
  await writeDigestStep(ctx, digest);
  return digest;
}

export async function writeDigestStep(ctx: RunCtx, digest: Digest): Promise<void> {
  const themes = Object.keys(digest.themes).length;
  await logStep(ctx, { node: "intake/digest", kind: "event", label: `Intake digest: ${digest.newBricks.length} new, ${digest.touched.length} touched, across ${themes} theme(s)`, detail: { digest }, lit: { bricks: digest.touched } });
}

export function digestText(digest: Digest): string {
  if (!digest.sources.length && !digest.touched.length) return "";
  const lines = [`Just filed: ${digest.sources.map((s) => `"${s.title}" (${s.parts} part(s)${s.failed ? `, ${s.failed} failed and kept for a retry` : ""})`).join(", ") || "the conversation"}. ${digest.newBricks.length} new bricks, ${digest.touched.length} touched, ${digest.superseded} old entries superseded.`];
  for (const [theme, t] of Object.entries(digest.themes)) lines.push(`- ${theme}: new ${t.new.slice(0, 15).join(", ") || "none"}; updated ${t.updated.slice(0, 15).join(", ") || "none"}${t.islands.length ? `; islands (linked to nothing older): ${t.islands.slice(0, 10).join(", ")}` : ""}`);
  if (digest.doubts.length) lines.push(`Doubts while filing: ${digest.doubts.slice(0, 5).join("; ")}`);
  if (digest.contradictions.length) lines.push(`Contradictions found: ${digest.contradictions.slice(0, 5).join("; ")}`);
  return lines.join("\n");
}

/**
 * On a big first intake its first goals are: write the first pages, then the life document, within the background
 * share (BUILD_SPEC §11). Code starts that goal once; the work is its own.
 */
export async function firstPagesGoal(ctx: RunCtx): Promise<void> {
  const lifeExists = (await ctx.db.query(`SELECT 1 FROM pages WHERE user_id=$1 AND kind='life' AND archived_at IS NULL`, [ctx.userId])).rows.length > 0;
  if (lifeExists) return;
  const n = (await ctx.db.query<{ n: string }>(`SELECT count(*) AS n FROM bricks WHERE user_id=$1 AND archived_at IS NULL AND kind<>'source'`, [ctx.userId])).rows[0];
  if (Number(n?.n ?? 0) < 15) return;
  if ((await listGoals(ctx)).some((g) => g.origin === "code" && /first pages/i.test(g.text))) return;
  const goal = await addGoal(ctx, { text: "Write the first pages, then the life document", why: "A big first intake: the web has bricks but no pages and no life document yet.", origin: "code" });
  await enqueue(ctx, { trigger: "schedule", job: "own", purpose: "Write the first pages from what was filed (themes worth a page, each with its purpose), then the life document", why: "first goal after a big intake", dueAt: new Date(ctx.now().getTime() + 60_000).toISOString(), parentGoalId: goal.id });
}
