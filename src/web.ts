import { id } from "./ids.js";
import { callJson, roleDown } from "./models.js";
import { bump, db, light, wake } from "./state.js";
import { NotFoundError, ValidationError } from "./errors.js";

/**
 * The web (IDEA.md): everything that comes in is a source, stored once. Summaries are made from sources and from
 * other summaries; one input can feed many summaries and one summary takes many inputs. "My life" sits at the centre,
 * empty at the start. Redundancy is on purpose: as many summaries as it likes, as long as each catches a new angle.
 */

export type Origin = "isaak" | "web" | "self" | "session";

export interface SourceIn {
  kind: string;
  origin: Origin;
  title?: string;
  text?: string;
  fileName?: string | null;
  mime?: string | null;
  bytes?: Buffer | null;
  readable?: boolean;
  projectId?: string | null;
}

export async function addSource(s: SourceIn): Promise<string> {
  const sourceId = id();
  await db().query(
    `INSERT INTO sources (id, kind, origin, title, text, file_name, mime, bytes, size, readable, project_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [sourceId, s.kind, s.origin, (s.title ?? "").slice(0, 300), s.text ?? "", s.fileName ?? null, s.mime ?? null, s.bytes ?? null, s.bytes?.length ?? (s.text ?? "").length, s.readable ?? true, s.projectId ?? null],
  );
  bump();
  wake();
  return sourceId;
}

export async function ensureLife(): Promise<string> {
  const r = await db().query<{ id: string }>(`SELECT id FROM summaries WHERE is_life = true LIMIT 1`);
  if (r.rows[0]) return r.rows[0].id;
  const lifeId = id();
  await db().query(`INSERT INTO summaries (id, title, body, is_life, stale) VALUES ($1,'My life','',true,false)`, [lifeId]);
  return lifeId;
}

export interface SummaryRow {
  id: string; title: string; body: string; kind: string; is_life: boolean; is_instructions: boolean; project_id: string | null;
  tags: string; stale: boolean; absorbed_at: string | null; created_at: string; updated_at: string;
}

export async function getSummary(summaryId: string): Promise<SummaryRow> {
  const r = await db().query<SummaryRow>(`SELECT * FROM summaries WHERE id = $1`, [summaryId]);
  if (!r.rows[0]) throw new NotFoundError("There is no such summary.");
  return r.rows[0];
}

async function createSummary(title: string, opts: { kind?: string; projectId?: string | null; instructions?: boolean } = {}): Promise<string> {
  const summaryId = id();
  await db().query(`INSERT INTO summaries (id, title, kind, project_id, is_instructions, stale) VALUES ($1,$2,$3,$4,$5,true)`,
    [summaryId, title.slice(0, 200), opts.kind ?? "summary", opts.projectId ?? null, opts.instructions ?? false]);
  return summaryId;
}

/** `input` feeds `summaryId`. A summary never feeds itself, nor anything it is made from (no loops). */
export async function feed(summaryId: string, inputType: "summary" | "source", inputId: string): Promise<void> {
  if (inputType === "summary") {
    if (inputId === summaryId) return;
    if ((await below(inputId)).has(summaryId)) return;
  }
  await db().query(`INSERT INTO feeds (summary_id, input_type, input_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [summaryId, inputType, inputId]);
}

export async function unfeed(summaryId: string, inputType: string, inputId: string): Promise<void> {
  await db().query(`DELETE FROM feeds WHERE summary_id = $1 AND input_type = $2 AND input_id = $3`, [summaryId, inputType, inputId]);
}

/** Every summary a summary is made from, all the way down. */
async function below(summaryId: string): Promise<Set<string>> {
  const seen = new Set<string>();
  let frontier = [summaryId];
  while (frontier.length) {
    const r = await db().query<{ input_id: string }>(`SELECT input_id FROM feeds WHERE input_type = 'summary' AND summary_id = ANY($1)`, [frontier]);
    frontier = r.rows.map((row) => row.input_id).filter((x) => !seen.has(x));
    for (const x of frontier) seen.add(x);
  }
  return seen;
}

/** Every summary built on these, all the way up to "my life". */
async function above(ids: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  let frontier = ids;
  while (frontier.length) {
    const r = await db().query<{ summary_id: string }>(`SELECT summary_id FROM feeds WHERE input_type = 'summary' AND input_id = ANY($1)`, [frontier]);
    frontier = r.rows.map((row) => row.summary_id).filter((x) => !seen.has(x));
    for (const x of frontier) seen.add(x);
  }
  return seen;
}

/** Marks these and everything built on them as outdated. */
export async function markStale(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const all = [...new Set([...ids, ...(await above(ids))])];
  await db().query(`UPDATE summaries SET stale = true WHERE id = ANY($1) AND absorbed_at IS NULL`, [all]);
  bump();
}

async function inputsOf(summaryId: string): Promise<{ type: string; id: string }[]> {
  const r = await db().query<{ input_type: string; input_id: string }>(`SELECT input_type, input_id FROM feeds WHERE summary_id = $1 ORDER BY created_at`, [summaryId]);
  return r.rows.map((row) => ({ type: row.input_type, id: row.input_id }));
}

/** The summaries made directly from this one (where it feeds into). */
async function parentsOf(summaryId: string): Promise<string[]> {
  const r = await db().query<{ summary_id: string }>(`SELECT summary_id FROM feeds WHERE input_type = 'summary' AND input_id = $1`, [summaryId]);
  return r.rows.map((row) => row.summary_id);
}

async function gist(summaryIds: string[]): Promise<{ id: string; title: string; gist: string; inputs: number }[]> {
  if (!summaryIds.length) return [];
  const r = await db().query<{ id: string; title: string; body: string; n: string }>(
    `SELECT s.id, s.title, s.body, (SELECT count(*) FROM feeds f WHERE f.summary_id = s.id AND f.input_type = 'summary') AS n
     FROM summaries s WHERE s.id = ANY($1) AND s.absorbed_at IS NULL`, [summaryIds]);
  return r.rows.map((row) => ({ id: row.id, title: row.title, gist: plain(row.body).slice(0, 280), inputs: Number(row.n) }));
}

/** A body without its markers, for the models' reading. */
export function plain(body: string): string {
  return body.replace(/\[\[(?:s|m|img):[^\]]+\]\]/g, "").replace(/\{\{\/?isaak\}\}/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

async function summaryChildren(summaryId: string): Promise<string[]> {
  const r = await db().query<{ input_id: string }>(`SELECT input_id FROM feeds WHERE summary_id = $1 AND input_type = 'summary'`, [summaryId]);
  return r.rows.map((row) => row.input_id);
}

const PLACE_SYSTEM = `You keep Isaak's memory: a web of summaries built from the outside in, with "My life" at the centre.
Every message and file is a source. Summaries are made from sources and from other summaries. One input can feed many summaries, and one summary can be made from many inputs.

Redundancy is on purpose. Isaak: "if I upload something about my internship, I don't just want it to create a summary of my internship. I want that to map this into different places." His internship may feed into his university, his university into his career, his career into his life; the internship also counts as exploring career possibilities, which feeds his career again; and there may be a summary of him in 2026, or of a project he is doing, where it is background context. Create as many summaries as you like, as long as each catches a new angle (a topic, a period of time, a project, a theme). A small piece that fits nowhere yet may stay unplaced until enough similar pieces make a summary worth having.

You look at the web one level at a time, starting at the centre. For the source you are shown, say:
- "fits": ids of the summaries shown that this source should feed directly (often several);
- "descend": ids of summaries shown whose inputs you want to see next, because the source may fit deeper there;
- "new": new summaries to make for angles that are missing, each with "title" and "under" (ids of shown summaries the new one should feed into);
- "instruction": true if the source is Isaak telling you how he wants you to behave or how to organise the web.
Answer with one JSON object: {"fits": [], "descend": [], "new": [{"title": "", "under": []}], "instruction": false, "why": "one line"}`;

/** Where a source fits: from the centre outward, one level at a time. */
export async function place(sourceId: string): Promise<{ fed: string[]; created: string[] }> {
  const r = await db().query<{ kind: string; origin: string; title: string; text: string; readable: boolean; file_name: string | null }>(
    `SELECT kind, origin, title, text, readable, file_name FROM sources WHERE id = $1`, [sourceId]);
  const src = r.rows[0];
  if (!src) throw new NotFoundError("No such source.");
  const content = src.readable
    ? `${src.title ? `${src.title}\n` : ""}${src.text}`.slice(0, 8000)
    : `(A file it cannot read yet: ${src.file_name ?? src.title}.)`;
  const result = await placeInput({ type: "source", id: sourceId }, `SOURCE (${src.kind}, from ${src.origin})`, content);
  await db().query(`UPDATE sources SET placed = true WHERE id = $1`, [sourceId]);
  return result;
}

/** A project's summary goes into the web the same way: it feeds every summary it is relevant to. */
export async function placeSummary(summaryId: string): Promise<{ fed: string[]; created: string[] }> {
  const s = await getSummary(summaryId);
  return placeInput({ type: "summary", id: summaryId }, `SUMMARY OF A PROJECT "${s.title}"`, plain(s.body).slice(0, 8000));
}

async function placeInput(input: { type: "summary" | "source"; id: string }, label: string, content: string): Promise<{ fed: string[]; created: string[] }> {
  if (roleDown("web")) throw new Error("Placing is shut down.");
  const lifeId = await ensureLife();
  const fed = new Set<string>();
  const created: string[] = [];
  let instruction = false;
  let frontier = [lifeId];
  const shown = new Set<string>(input.type === "summary" ? [input.id] : []);
  for (let depth = 0; depth < 8 && frontier.length; depth += 1) {
    const level: { id: string; title: string; gist: string; inputs: number; under?: string }[] = [];
    for (const parent of frontier) {
      if (!shown.has(parent)) level.push(...(await gist([parent])));
      for (const child of await gist(await summaryChildren(parent))) if (!shown.has(child.id) && !level.some((l) => l.id === child.id)) level.push({ ...child, under: parent });
    }
    for (const s of level) shown.add(s.id);
    if (!level.length) break;
    const listing = level.map((s) => `- ${s.id} | ${s.title}${s.under ? ` (feeds ${s.under})` : " (centre)"} | ${s.inputs} summary inputs | ${s.gist || "(empty so far)"}`).join("\n");
    const out = await callJson<{ fits?: string[]; descend?: string[]; new?: { title: string; under?: string[] }[]; instruction?: boolean }>("web", {
      task: "place",
      system: PLACE_SYSTEM,
      prompt: `${label}:\n${content}\n\nSUMMARIES AT THIS LEVEL:\n${listing}`,
      maxTokens: 2000,
    });
    const known = new Set(level.map((s) => s.id));
    for (const f of out.fits ?? []) if (known.has(f)) fed.add(f);
    for (const n of out.new ?? []) {
      if (!n?.title?.trim()) continue;
      const under = (n.under ?? []).filter((u) => known.has(u));
      const newId = await createSummary(n.title.trim());
      created.push(newId);
      for (const u of under.length ? under : [lifeId]) await feed(u, "summary", newId);
      fed.add(newId);
    }
    if (out.instruction && input.type === "source") instruction = true;
    frontier = (out.descend ?? []).filter((d) => known.has(d));
  }
  if (instruction) fed.add(await instructionsSummary());
  for (const target of fed) await feed(target, input.type, input.id);
  await markStale([...fed]);
  light([...fed]);
  return { fed: [...fed], created };
}

/** His instructions on how it should behave and organise itself: their own summary, inside "my life". */
export async function instructionsSummary(): Promise<string> {
  const r = await db().query<{ id: string }>(`SELECT id FROM summaries WHERE is_instructions = true AND absorbed_at IS NULL LIMIT 1`);
  if (r.rows[0]) return r.rows[0].id;
  const lifeId = await ensureLife();
  const instrId = await createSummary("How Isaak wants me to work", { instructions: true });
  await feed(lifeId, "summary", instrId);
  return instrId;
}

const WRITE_SYSTEM = `You write one summary in Isaak's memory web from its inputs. A summary is plain text: one cohesive piece, not a bullet list of its inputs. Combine the inputs into a whole. You may repeat an input almost word for word, or shrink it to a couple of lines: your call.

Mark where every statement comes from, right after it, with the input's marker exactly as given: [[s:ID]] for a source, [[m:ID]] for a summary. A statement with no marker is your own thought, conclusion or guess, and it shows as such, so only leave a statement unmarked when it really is yours.
Where a picture from the inputs makes the summary more alive, put it on its own line as [[img:ID]] (only for inputs marked as pictures).
Text marked as typed by Isaak himself is his own edit of this summary: weigh it and decide what to do with it.
If a summary input is a summary of a project, say so plainly.

Answer with one JSON object: {"title": "a short title", "body": "the summary with its markers", "tags": ["a few short labels for filtering: topics, periods, kinds"]}`;

/** Rewrites a summary from its inputs. */
export async function rewrite(summaryId: string, extra = ""): Promise<void> {
  if (roleDown("web")) throw new Error("Summaries are shut down.");
  const s = await getSummary(summaryId);
  const inputs = await inputsOf(summaryId);
  const parts: string[] = [];
  let budget = 90_000;
  for (const input of inputs) {
    if (budget <= 0) break;
    if (input.type === "summary") {
      const r = await db().query<{ title: string; body: string; stale: boolean; kind: string }>(`SELECT title, body, stale, kind FROM summaries WHERE id = $1 AND absorbed_at IS NULL`, [input.id]);
      const row = r.rows[0];
      if (!row) continue;
      const text = `[[m:${input.id}]] SUMMARY${row.kind === "project" ? " OF A PROJECT" : ""} "${row.title}":\n${plain(row.body).slice(0, 4000) || "(still empty)"}`;
      parts.push(text); budget -= text.length;
    } else {
      const r = await db().query<{ kind: string; origin: string; title: string; text: string; mime: string | null; readable: boolean; file_name: string | null; created_at: string }>(
        `SELECT kind, origin, title, text, mime, readable, file_name, created_at FROM sources WHERE id = $1`, [input.id]);
      const row = r.rows[0];
      if (!row) continue;
      const pic = row.mime?.startsWith("image/") ? " (A PICTURE; you may show it with [[img:" + input.id + "]])" : "";
      const who = row.kind === "edit" ? "TYPED BY ISAAK HIMSELF INTO THIS SUMMARY" : `${row.kind} from ${row.origin}`;
      const body = row.readable ? row.text.slice(0, 6000) : `(a file it cannot read yet: ${row.file_name})`;
      const text = `[[s:${input.id}]] SOURCE (${who}, ${new Date(row.created_at).toISOString().slice(0, 10)})${pic}${row.title ? ` "${row.title}"` : ""}:\n${body}`;
      parts.push(text); budget -= text.length;
    }
  }
  const out = await callJson<{ title?: string; body?: string; tags?: string[] }>("web", {
    task: "rewrite",
    system: WRITE_SYSTEM,
    prompt: `${s.is_life ? 'This is "My life", the centre: the summary of his whole life, built from everything below it.\n' : ""}${s.is_instructions ? "This summary holds Isaak's instructions on how you should behave and organise the web. Keep them precise; newer instructions win over older ones that contradict them, and say so.\n" : ""}CURRENT TITLE: ${s.title}\nCURRENT TEXT:\n${s.body || "(empty)"}\n${extra ? `\nISAAK ASKS FOR THIS REVISION: ${extra}\n` : ""}\nINPUTS:\n${parts.join("\n\n") || "(none yet)"}`,
    maxTokens: 8000,
  });
  const body = String(out.body ?? s.body);
  const title = s.is_life ? "My life" : String(out.title ?? s.title).slice(0, 200);
  await db().query(`INSERT INTO summary_versions (id, summary_id, title, body, why) VALUES ($1,$2,$3,$4,$5)`, [id(), summaryId, s.title, s.body, extra ? `revision: ${extra}` : "rewritten from its inputs"]);
  await db().query(`UPDATE summaries SET title = $2, body = $3, tags = $4, stale = false, updated_at = now() WHERE id = $1`,
    [summaryId, title, body, JSON.stringify((out.tags ?? []).map(String).slice(0, 12))]);
  light([summaryId]);
}

/** Touch: anything read is brought up to date first (outdated inputs first, so it is built on fresh ones). */
export async function freshen(summaryIds: string[]): Promise<void> {
  for (const sid of summaryIds) {
    const order = [...(await below(sid))];
    const stale = await db().query<{ id: string }>(`SELECT id FROM summaries WHERE id = ANY($1) AND stale = true AND absorbed_at IS NULL`, [[...order, sid]]);
    const staleSet = new Set(stale.rows.map((row) => row.id));
    // Deepest first: a summary is rewritten after everything it is made from.
    const ordered = await depthOrder([...staleSet]);
    for (const x of ordered) await rewrite(x);
  }
}

async function depthOrder(ids: string[]): Promise<string[]> {
  const depth = new Map<string, number>();
  for (const x of ids) depth.set(x, (await below(x)).size);
  return ids.sort((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0));
}

/** His own typing in a summary: kept as a source, marked as his, and the summary shows it as he wrote it. */
export async function editByIsaak(summaryId: string, newBody: string): Promise<void> {
  const s = await getSummary(summaryId);
  // He edits the plain text; a line he left as it was keeps its markers, a line he wrote or changed is marked as his.
  const oldByPlain = new Map<string, string>();
  for (const line of s.body.split("\n")) { const p = plain(line).trim(); if (p) oldByPlain.set(p, line); }
  const marked = newBody.split("\n").map((line) => {
    const t = line.trim();
    if (!t) return line;
    const kept = oldByPlain.get(t);
    if (kept !== undefined) return kept;
    return `{{isaak}}${line}{{/isaak}}`;
  }).join("\n");
  const sourceId = await addSource({ kind: "edit", origin: "isaak", title: `Isaak's edit of "${s.title}"`, text: newBody });
  await db().query(`UPDATE sources SET placed = true WHERE id = $1`, [sourceId]);
  await feed(summaryId, "source", sourceId);
  await db().query(`INSERT INTO summary_versions (id, summary_id, title, body, why) VALUES ($1,$2,$3,$4,'Isaak typed into it')`, [id(), summaryId, s.title, s.body]);
  await db().query(`UPDATE summaries SET body = $2, stale = false, updated_at = now() WHERE id = $1`, [summaryId, marked]);
  const parents = await parentsOf(summaryId);
  await markStale(parents);
}

/** "Don't like this summary, absorb it into the rest of the web": its inputs go to what it fed, and it is gone. */
export async function absorb(summaryId: string): Promise<void> {
  const s = await getSummary(summaryId);
  if (s.is_life) throw new ValidationError("My life is the centre; it can't be absorbed.");
  const parents = await parentsOf(summaryId);
  const lifeId = await ensureLife();
  for (const input of await inputsOf(summaryId)) {
    for (const p of parents.length ? parents : [lifeId]) await feed(p, input.type as "summary" | "source", input.id);
  }
  await db().query(`DELETE FROM feeds WHERE summary_id = $1 OR (input_type = 'summary' AND input_id = $1)`, [summaryId]);
  await db().query(`UPDATE summaries SET absorbed_at = now() WHERE id = $1`, [summaryId]);
  await markStale(parents.length ? parents : [lifeId]);
}

const REVISE_SYSTEM = `Isaak pressed the revise button on one summary of his memory web and said what he wants. Decide what that means:
- "rewrite": rewrite this summary following his words;
- "absorb": he doesn't want this summary; fold it into the rest of the web;
- "restructure": he wants the web around it changed (new summaries, moved inputs). Describe the changes in "changes" as a list of actions: {"do":"create","title":"","under":["summary ids"],"inputs":["s:ID or m:ID"]}, {"do":"move","input":"s:ID or m:ID","from":"summary id","to":"summary id"}, {"do":"link","input":"s:ID or m:ID","into":"summary id"}, {"do":"unlink","input":"s:ID or m:ID","from":"summary id"}, {"do":"rename","id":"summary id","title":""}.
Answer with one JSON object: {"action": "rewrite" | "absorb" | "restructure", "changes": [], "say": "one line back to him"}`;

/** The revise button: his words, kept as a source of this summary, then rewrite, absorb or restructure. */
export async function revise(summaryId: string, words: string): Promise<{ action: string; say: string }> {
  const s = await getSummary(summaryId);
  const sourceId = await addSource({ kind: "revision", origin: "isaak", title: `Revision asked for "${s.title}"`, text: words });
  await db().query(`UPDATE sources SET placed = true WHERE id = $1`, [sourceId]);
  await feed(summaryId, "source", sourceId);
  const nearby = await gist([...(await parentsOf(summaryId)), ...(await summaryChildren(summaryId))]);
  const out = await callJson<{ action?: string; changes?: Change[]; say?: string }>("web", {
    task: "revise",
    system: REVISE_SYSTEM,
    prompt: `SUMMARY ${summaryId} "${s.title}":\n${s.body}\n\nAROUND IT:\n${nearby.map((n) => `- ${n.id} | ${n.title} | ${n.gist}`).join("\n") || "(nothing)"}\n\nISAAK SAYS: ${words}`,
    maxTokens: 3000,
  });
  const action = out.action === "absorb" ? "absorb" : out.action === "restructure" ? "restructure" : "rewrite";
  if (action === "absorb") await absorb(summaryId);
  else if (action === "restructure") { await applyChanges(out.changes ?? []); await markStale([summaryId]); await freshen([summaryId]); }
  else await rewrite(summaryId, words);
  return { action, say: String(out.say ?? "") };
}

export interface Change { do: string; title?: string; under?: string[]; inputs?: string[]; input?: string; from?: string; to?: string; into?: string; id?: string }

function ref(r: string): { type: "summary" | "source"; id: string } | null {
  const m = /^(s|m):(.+)$/.exec(r.trim());
  if (!m) return null;
  return { type: m[1] === "s" ? "source" : "summary", id: m[2] };
}

/** Changes to the web's structure, from the chat or the revise button. Unknown ids are skipped. */
export async function applyChanges(changes: Change[]): Promise<string[]> {
  const touched: string[] = [];
  const exists = async (sid: string) => Boolean((await db().query(`SELECT 1 FROM summaries WHERE id = $1 AND absorbed_at IS NULL`, [sid])).rows[0]);
  for (const c of changes.slice(0, 40)) {
    try {
      if (c.do === "create" && c.title?.trim()) {
        const newId = await createSummary(c.title.trim());
        const under = [];
        for (const u of c.under ?? []) if (await exists(u)) under.push(u);
        for (const u of under.length ? under : [await ensureLife()]) { await feed(u, "summary", newId); touched.push(u); }
        for (const i of c.inputs ?? []) { const r = ref(i); if (r) await feed(newId, r.type, r.id); }
        touched.push(newId);
      } else if (c.do === "move" && c.input && c.from && c.to) {
        const r = ref(c.input); if (!r || !(await exists(c.to))) continue;
        await unfeed(c.from, r.type, r.id); await feed(c.to, r.type, r.id); touched.push(c.from, c.to);
      } else if (c.do === "link" && c.input && c.into) {
        const r = ref(c.input); if (!r || !(await exists(c.into))) continue;
        await feed(c.into, r.type, r.id); touched.push(c.into);
      } else if (c.do === "unlink" && c.input && c.from) {
        const r = ref(c.input); if (!r) continue;
        await unfeed(c.from, r.type, r.id); touched.push(c.from);
      } else if (c.do === "rename" && c.id && c.title?.trim()) {
        await db().query(`UPDATE summaries SET title = $2 WHERE id = $1 AND is_life = false`, [c.id, c.title.trim().slice(0, 200)]); touched.push(c.id);
      } else if (c.do === "absorb" && c.id) {
        await absorb(c.id);
      }
    } catch { /* one bad change does not stop the rest */ }
  }
  await markStale(touched);
  light(touched);
  return touched;
}

/** The whole web for the screen: every summary with what it is made from. The page draws the tree from "my life". */
export async function webView() {
  const lifeId = await ensureLife();
  const s = await db().query<{ id: string; title: string; kind: string; is_life: boolean; is_instructions: boolean; project_id: string | null; tags: string; stale: boolean; updated_at: string; created_at: string }>(
    `SELECT id, title, kind, is_life, is_instructions, project_id, tags, stale, updated_at, created_at FROM summaries WHERE absorbed_at IS NULL`);
  const f = await db().query<{ summary_id: string; input_type: string; input_id: string }>(`SELECT summary_id, input_type, input_id FROM feeds`);
  const src = await db().query<{ id: string; kind: string; origin: string; title: string; file_name: string | null; mime: string | null; readable: boolean; placed: boolean; created_at: string; text: string }>(
    `SELECT id, kind, origin, title, file_name, mime, readable, placed, created_at, left(text, 140) AS text FROM sources ORDER BY created_at DESC LIMIT 2000`);
  const inputs: Record<string, { type: string; id: string }[]> = {};
  for (const row of f.rows) (inputs[row.summary_id] ??= []).push({ type: row.input_type, id: row.input_id });
  return {
    lifeId,
    summaries: s.rows.map((row) => ({ ...row, tags: safeTags(row.tags), inputs: inputs[row.id] ?? [] })),
    sources: src.rows.map((row) => ({ ...row, title: row.title || row.file_name || row.text.slice(0, 80) })),
  };
}

function safeTags(raw: string): string[] {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

/** One summary for its popup: the text, what its markers point at (and their colour), its history. */
export async function summaryView(summaryId: string, touch = true) {
  if (touch) { try { await freshen([summaryId]); } catch { /* shown as it is when summaries are shut down */ } }
  const s = await getSummary(summaryId);
  const refs: Record<string, { type: string; title: string; origin: string; mime?: string | null }> = {};
  const ids = [...s.body.matchAll(/\[\[(s|m|img):([^\]]+)\]\]/g)].map((m) => ({ t: m[1], id: m[2] }));
  for (const r of ids) {
    if (refs[r.id]) continue;
    if (r.t === "m") {
      const row = (await db().query<{ title: string; kind: string }>(`SELECT title, kind FROM summaries WHERE id = $1`, [r.id])).rows[0];
      if (row) refs[r.id] = { type: "summary", title: row.title, origin: row.kind === "project" ? "session" : await originOf(r.id) };
    } else {
      const row = (await db().query<{ title: string; origin: string; kind: string; mime: string | null; file_name: string | null }>(`SELECT title, origin, kind, mime, file_name FROM sources WHERE id = $1`, [r.id])).rows[0];
      if (row) refs[r.id] = { type: "source", title: row.title || row.file_name || row.kind, origin: row.origin, mime: row.mime };
    }
  }
  const versions = await db().query<{ id: string; title: string; body: string; why: string; created_at: string }>(
    `SELECT id, title, body, why, created_at FROM summary_versions WHERE summary_id = $1 ORDER BY created_at DESC LIMIT 50`, [summaryId]);
  light([summaryId]);
  return { ...s, tags: safeTags(s.tags), refs, versions: versions.rows, inputs: await inputsOf(summaryId), feedsInto: await titled(await parentsOf(summaryId)) };
}

async function titled(ids: string[]): Promise<{ id: string; title: string }[]> {
  if (!ids.length) return [];
  const r = await db().query<{ id: string; title: string }>(`SELECT id, title FROM summaries WHERE id = ANY($1) AND absorbed_at IS NULL`, [ids]);
  return r.rows;
}

/** The colour of a summary used as a source: where most of what it rests on came from. */
async function originOf(summaryId: string): Promise<string> {
  const all = [summaryId, ...(await below(summaryId))];
  const r = await db().query<{ origin: string; n: string }>(
    `SELECT s.origin, count(*) AS n FROM feeds f JOIN sources s ON s.id = f.input_id WHERE f.input_type = 'source' AND f.summary_id = ANY($1) GROUP BY s.origin ORDER BY n DESC`, [all]);
  return r.rows[0]?.origin ?? "self";
}

export async function sourceView(sourceId: string) {
  const r = await db().query(`SELECT id, kind, origin, title, text, file_name, mime, size, readable, placed, project_id, created_at FROM sources WHERE id = $1`, [sourceId]);
  if (!r.rows[0]) throw new NotFoundError("No such source.");
  const into = await db().query<{ summary_id: string }>(`SELECT summary_id FROM feeds WHERE input_type = 'source' AND input_id = $1`, [sourceId]);
  return { ...r.rows[0], feedsInto: await titled(into.rows.map((row) => row.summary_id)) };
}

export async function sourceFile(sourceId: string): Promise<{ bytes: Buffer; mime: string; name: string } | null> {
  const r = await db().query<{ bytes: Buffer | Uint8Array | null; mime: string | null; file_name: string | null }>(`SELECT bytes, mime, file_name FROM sources WHERE id = $1`, [sourceId]);
  const row = r.rows[0];
  if (!row?.bytes) return null;
  return { bytes: Buffer.from(row.bytes), mime: row.mime ?? "application/octet-stream", name: row.file_name ?? "file" };
}

/** Sources not placed yet, oldest first: the first thing its own work does. */
export async function unplaced(limit = 5): Promise<string[]> {
  const r = await db().query<{ id: string }>(`SELECT id FROM sources WHERE placed = false ORDER BY created_at LIMIT $1`, [limit]);
  return r.rows.map((row) => row.id);
}

export async function staleSummaries(limit = 3): Promise<string[]> {
  const r = await db().query<{ id: string }>(`SELECT id FROM summaries WHERE stale = true AND absorbed_at IS NULL ORDER BY updated_at LIMIT $1`, [limit]);
  return r.rows.map((row) => row.id);
}

/** For the chat's rounds: the summaries one level further from what it has read. */
export async function nextLevel(readIds: string[]): Promise<{ id: string; title: string; gist: string; inputs: number }[]> {
  const out = new Set<string>();
  for (const sid of readIds) for (const c of await summaryChildren(sid)) if (!readIds.includes(c)) out.add(c);
  return gist([...out]);
}

export async function readSummaries(ids: string[]): Promise<{ id: string; title: string; body: string }[]> {
  if (!ids.length) return [];
  try { await freshen(ids); } catch { /* read as they are */ }
  const r = await db().query<{ id: string; title: string; body: string }>(`SELECT id, title, body FROM summaries WHERE id = ANY($1) AND absorbed_at IS NULL`, [ids]);
  light(ids);
  return r.rows;
}

export async function lifeAndInstructions(): Promise<{ life: { id: string; body: string }; instructions: { id: string; body: string } | null }> {
  const lifeId = await ensureLife();
  const r = await db().query<{ id: string; body: string; is_instructions: boolean }>(
    `SELECT id, body, is_instructions FROM summaries WHERE (id = $1 OR is_instructions = true) AND absorbed_at IS NULL`, [lifeId]);
  const life = r.rows.find((row) => row.id === lifeId)!;
  const instr = r.rows.find((row) => row.is_instructions) ?? null;
  return { life: { id: life.id, body: life.body }, instructions: instr ? { id: instr.id, body: instr.body } : null };
}

/** Its own projects' summaries live in the web too: a project summary feeds what the project was about. */
export async function projectSummary(projectId: string, title: string): Promise<string> {
  const r = await db().query<{ id: string }>(`SELECT id FROM summaries WHERE project_id = $1 AND kind = 'project' AND absorbed_at IS NULL LIMIT 1`, [projectId]);
  if (r.rows[0]) return r.rows[0].id;
  const sid = await createSummary(title, { kind: "project", projectId });
  return sid;
}

export { createSummary, parentsOf, inputsOf, below, above };
