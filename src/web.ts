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
  tags: string; stale: boolean; absorbed_at: string | null; created_at: string; updated_at: string; went_into?: string; merged_from?: string;
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

const ORIGIN_TAG: Record<string, string> = { isaak: "from Isaak", web: "from the web/outside", self: "from your own earlier message", session: "from a work session" };

/**
 * A body as the models read it: every marker becomes a readable tag saying where that statement came from, so a model
 * sees what the colours show Isaak (Isaak, 15 Nov: the colour "should be visible to the AI, obviously, too").
 * A statement with no tag is a model's own earlier thought.
 */
export async function annotate(body: string): Promise<string> {
  if (!body) return "";
  const ids = [...new Set([...body.matchAll(/\[\[(s|m|img):([^\]]+)\]\]/g)].map((m) => `${m[1]}:${m[2]}`))];
  const tags = new Map<string, string>();
  for (const key of ids) {
    const [t, rid] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    if (t === "m") {
      const row = (await db().query<{ title: string; kind: string }>(`SELECT title, kind FROM summaries WHERE id = $1`, [rid])).rows[0];
      tags.set(key, row ? `[from the summary "${row.title}", mostly ${ORIGIN_TAG[row.kind === "project" ? "session" : await originOf(rid)] ?? "its own thoughts"}]` : "[from a summary that is gone]");
    } else {
      const row = (await db().query<{ origin: string; kind: string; title: string; file_name: string | null }>(`SELECT origin, kind, title, file_name FROM sources WHERE id = $1`, [rid])).rows[0];
      tags.set(key, t === "img" ? `[picture: ${row?.file_name ?? row?.title ?? "gone"}]` : row ? `[${ORIGIN_TAG[row.origin] ?? row.origin}${row.kind === "reply" ? " in the chat" : row.kind === "file" ? `, file ${row.file_name ?? ""}` : ""}]` : "[from a source that is gone]");
    }
  }
  return body
    .replace(/\[\[(s|m|img):([^\]]+)\]\]/g, (_m, t, rid) => ` ${tags.get(`${t}:${rid}`) ?? ""}`)
    .replace(/\{\{isaak\}\}([\s\S]*?)\{\{\/isaak\}\}/g, (_m, inner) => `[typed by Isaak himself:] ${inner}`)
    .trim();
}

/** A body without its markers (for matching his edits and short previews). */
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

HOW THE WEB IS LAYERED (from Isaak's own examples). The further out, the more detailed and neutral; the closer to "My life", the more general and the more coloured by the context it sits in.
- Example, his internship: outermost "Internship: the facts" (what happened, neutral). When it counts towards different contexts, each context gets its own angled version made from the facts: "the internship as part of his studies" under University, "the internship as career exploration" under Career, "the internship as a piece of his year" under Me in 2026. The same facts summary then sits under each angled version. Only if the internship really matters as a thread of its own, a summary of what it means to him as a whole sits further in, made from the angled versions. Whether that layer exists is your judgement.
- Example, his language: first a summary of how he speaks; later, when he asks for a personal profile of him, the profile takes "how he speaks" under it.
- Example, the top layer: when everything so far is about him as a person and about the system, only two summaries belong directly under "My life": him, and the system. When he starts telling about his career and his life, a third appears.
To make an angled version of something that exists: create the new summary (in "new") under its context and let it take the existing one.

You see the whole web at once: every summary with its title, one line of what it holds, and what it feeds into. For the source you are shown, say:
- "fits": ids of the summaries this source should feed directly (often several). If the source covers the same angle as an existing summary, it goes into that summary, not into a new one;
- "new": new summaries only for an angle no existing summary covers yet, each with "title" (the lasting topic or angle, not an event), "under" (ids of summaries it should feed into) and "takes" (ids of existing summaries that should now feed into it; e.g. a new personal profile takes the existing summary of how he speaks);
- "instruction": true if the source is Isaak telling you how he wants you to behave or how to organise the web.
Where a summary sits in the tree is not fixed: when a new angle shows that existing summaries belong under it, use "takes".
Answer with one JSON object: {"fits": [], "new": [{"title": "", "under": [], "takes": []}], "instruction": false, "why": "one line"}`;

/** Where a source fits: it sees the whole web (titles and one line each) and places it. */
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
  // The whole web at once: title, one line, and what each feeds into.
  const all = await db().query<{ id: string; title: string; body: string; is_life: boolean; kind: string }>(
    `SELECT id, title, body, is_life, kind FROM summaries WHERE absorbed_at IS NULL ORDER BY created_at`);
  const up = await db().query<{ summary_id: string; input_id: string }>(`SELECT summary_id, input_id FROM feeds WHERE input_type = 'summary'`);
  const into = new Map<string, string[]>();
  for (const row of up.rows) (into.get(row.input_id) ?? into.set(row.input_id, []).get(row.input_id)!).push(row.summary_id);
  const known = new Set(all.rows.map((r) => r.id).filter((x) => !(input.type === "summary" && x === input.id)));
  const outline = all.rows.filter((r) => known.has(r.id)).map((r) => {
    const line = plain(r.body).replace(/\s+/g, " ").slice(0, 220);
    return `- ${r.id} | ${r.is_life ? "My life (the centre)" : r.title}${r.kind === "project" ? " (project)" : ""} | ${line || "(empty so far)"}${into.get(r.id)?.length ? ` | feeds: ${into.get(r.id)!.join(", ")}` : ""}`;
  }).join("\n");
  // First it picks the summaries that might hold this angle, then it reads those in full before deciding.
  const pick = await callJson<{ read?: string[] }>("web", {
    task: "place-candidates",
    system: `You keep Isaak's memory web. A new source has to be placed. From the whole web (title and one line each), pick the summaries you need to read in full to judge whether the source belongs in them or covers a new angle. Answer with one JSON object: {"read": ["summary ids"]}`,
    prompt: `${label}:\n${content}\n\nTHE WHOLE WEB:\n${outline}`,
    maxTokens: 800,
  });
  const candidates = (pick.read ?? []).filter((x) => known.has(x)).slice(0, 12);
  const fullTexts: string[] = [];
  for (const cid of candidates) {
    const row = all.rows.find((r) => r.id === cid)!;
    fullTexts.push(`${cid} | ${row.is_life ? "My life" : row.title}:\n${(await annotate(row.body)) || "(empty so far)"}`);
  }
  const out = await callJson<{ fits?: string[]; new?: { title: string; under?: string[]; takes?: string[] }[]; instruction?: boolean }>("web", {
    task: "place",
    system: PLACE_SYSTEM,
    prompt: `${label}:\n${content}\n\nTHE WHOLE WEB:\n${outline}${fullTexts.length ? `\n\nREAD IN FULL:\n${fullTexts.join("\n\n")}` : ""}`,
    maxTokens: 3000,
  });
  for (const f of out.fits ?? []) if (known.has(f)) fed.add(f);
  for (const n of out.new ?? []) {
    if (!n?.title?.trim()) continue;
    const under = (n.under ?? []).filter((u) => known.has(u));
    const newId = await createSummary(n.title.trim());
    created.push(newId);
    for (const u of under.length ? under : [lifeId]) await feed(u, "summary", newId);
    for (const t of (n.takes ?? []).filter((x) => known.has(x) && x !== lifeId)) await feed(newId, "summary", t);
    fed.add(newId);
  }
  if (out.instruction && input.type === "source") fed.add(await instructionsSummary());
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
In summary inputs, tags in square brackets say where each statement came from (from Isaak, from the web, from your own earlier message, from a work session); a statement without a tag was a model's own thought.
If a summary input is a summary of a project, say so plainly.

The title names the lasting topic or angle of this summary, not the latest event; keep the current title unless the angle itself changed.

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
      const text = `[[m:${input.id}]] SUMMARY${row.kind === "project" ? " OF A PROJECT" : ""} "${row.title}":\n${(await annotate(row.body)).slice(0, 5000) || "(still empty)"}`;
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
  await db().query(`UPDATE summaries SET absorbed_at = now(), went_into = $2 WHERE id = $1`, [summaryId, (parents.length ? parents : [lifeId]).join(",")]);
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

export interface Change { do: string; title?: string; under?: string[]; inputs?: string[]; input?: string; from?: string; to?: string; into?: string; id?: string; ids?: string[] }

function ref(r: string): { type: "summary" | "source"; id: string } | null {
  const m = /^(s|m):(.+)$/.exec(r.trim());
  if (!m) return null;
  return { type: m[1] === "s" ? "source" : "summary", id: m[2] };
}

/** Changes to the web's structure, from the chat or the revise button. Unknown ids are skipped. */
export async function applyChanges(changes: Change[]): Promise<string[]> {
  const touched: string[] = [];
  const mergedIds: string[] = [];
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
      } else if (c.do === "merge" && Array.isArray(c.ids)) {
        const ids: string[] = [];
        for (const m of c.ids) if (await exists(m) && !ids.includes(m)) ids.push(m);
        if (ids.length >= 2) { const merged = await merge(ids, c.title); touched.push(merged); mergedIds.push(merged); }
      }
    } catch { /* one bad change does not stop the rest */ }
  }
  await markStale(touched);
  light(touched);
  // A merged summary is rewritten right away: what overlapped once, what each brought kept (Isaak, 16 Nov).
  for (const m of mergedIds) { try { await rewrite(m, "These summaries were merged into this one. What they had in common appears once; what each one brought of its own stays."); } catch { /* rewritten when touched */ } }
  return touched;
}

/** Several summaries become one: it takes all their inputs and feeds everything they fed. */
async function merge(ids: string[], title?: string): Promise<string> {
  const rows = (await db().query<{ id: string; title: string; is_life: boolean }>(`SELECT id, title, is_life FROM summaries WHERE id = ANY($1)`, [ids])).rows.filter((r) => !r.is_life);
  if (rows.length < 2) throw new ValidationError("Merging needs two summaries (and never My life).");
  const mergedId = await createSummary((title?.trim() || rows.map((r) => r.title).join(" / ")).slice(0, 200));
  const all = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    for (const input of await inputsOf(r.id)) if (!(input.type === "summary" && all.has(input.id))) await feed(mergedId, input.type as "summary" | "source", input.id);
    for (const p of await parentsOf(r.id)) if (!all.has(p)) await feed(p, "summary", mergedId);
  }
  if (!(await parentsOf(mergedId)).length) await feed(await ensureLife(), "summary", mergedId);
  for (const r of rows) {
    await db().query(`DELETE FROM feeds WHERE summary_id = $1 OR (input_type = 'summary' AND input_id = $1)`, [r.id]);
    await db().query(`UPDATE summaries SET absorbed_at = now(), went_into = $2 WHERE id = $1`, [r.id, mergedId]);
  }
  await db().query(`UPDATE summaries SET merged_from = $2 WHERE id = $1`, [mergedId, JSON.stringify(rows.map((r) => ({ id: r.id, title: r.title })))]);
  return mergedId;
}

const TREE_SYSTEM = `Isaak switched on the tree button: his message is about how his memory web is organised. Change the tree the way he means. You see the whole web; read in full what you need.

HOW THE WEB IS LAYERED (from Isaak's own examples). The further out, the more detailed and neutral; the closer to "My life", the more general and the more coloured by the context it sits in.
- Example, his internship: outermost "Internship: the facts" (what happened, neutral). When it counts towards different contexts, each context gets its own angled version made from the facts: "the internship as part of his studies" under University, "the internship as career exploration" under Career, "the internship as a piece of his year" under Me in 2026. The same facts summary then sits under each angled version. Only if the internship really matters as a thread of its own, a summary of what it means to him as a whole sits further in, made from the angled versions. Whether that layer exists is your judgement.
- Example, his language: first a summary of how he speaks; later, when he asks for a personal profile of him, the profile takes "how he speaks" under it.
- Example, the top layer: when everything so far is about him as a person and about the system, only two summaries belong directly under "My life": him, and the system. When he starts telling about his career and his life, a third appears.
To make an angled version of something that exists: create the new summary (with create) under its context and let it take the existing one.

Changes you can make (a list in "changes"):
- {"do":"create","title":"","under":["summary ids"],"inputs":["s:ID or m:ID"]}
- {"do":"move","input":"s:ID or m:ID","from":"summary id","to":"summary id"}
- {"do":"link","input":"s:ID or m:ID","into":"summary id"}
- {"do":"unlink","input":"s:ID or m:ID","from":"summary id"}
- {"do":"rename","id":"summary id","title":""}
- {"do":"merge","ids":["summary ids"],"title":""}: summaries that partly cover the same become one; what overlaps appears once, what each brings stays
- {"do":"absorb","id":"summary id"}: a summary goes, its inputs go to what it fed
Answer with one JSON object: {"changes": [], "say": "one paragraph for Isaak: what you changed and why"}`;

const LAYERS = `HOW THE WEB IS LAYERED (from Isaak's own examples). The further out, the more detailed and neutral; the closer to "My life", the more general and the more coloured by the context it sits in.
- Example, his internship: outermost "Internship: the facts" (what happened, neutral). When it counts towards different contexts, each context gets its own angled version made from the facts: "the internship as part of his studies" under University, "the internship as career exploration" under Career, "the internship as a piece of his year" under Me in 2026. The same facts summary then sits under each angled version. Only if the internship really matters as a thread of its own, a summary of what it means to him as a whole sits further in, made from the angled versions. Whether that layer exists is your judgement.
- Example, his language: first a summary of how he speaks; later, when he asks for a personal profile of him, the profile takes "how he speaks" under it.
- Example, the top layer: when everything so far is about him as a person and about the system, only two summaries belong directly under "My life": him, and the system. When he starts telling about his career and his life, a third appears.
To make an angled version of something that exists: create the new summary (in "new") under its context and let it take the existing one.
`;

const TIDY_SYSTEM = `You keep Isaak's memory web. Something new was just placed. Look at the whole tree and judge: does it still show the big picture at the right level, given what just came in? Most new input fits inside what is already there and changes nothing; then make no changes. Only when something meaningfully new arrived, or the tree no longer shows the big picture at the right level, regroup it.
${LAYERS}
Changes you can make (a list in "changes"): {"do":"create","title":"","under":["summary ids"],"inputs":["m:ID"]}, {"do":"move","input":"m:ID","from":"summary id","to":"summary id"}, {"do":"link","input":"m:ID","into":"summary id"}, {"do":"unlink","input":"m:ID","from":"summary id"}, {"do":"rename","id":"","title":""}, {"do":"merge","ids":[],"title":""}.
Answer with one JSON object: {"changes": [], "say": "if you changed something: one sentence for Isaak on what you regrouped and why; else empty"}`;

export const TIDY_WHOLE_SYSTEM = TIDY_SYSTEM.replace(
  /^You keep Isaak's memory web\. Something new was just placed\. Look at the whole tree and judge: does it still show the big picture at the right level, given what just came in\? Most new input fits inside what is already there and changes nothing; then make no changes\. Only when something meaningfully new arrived, or the tree no longer shows the big picture at the right level, regroup it\./,
  "You keep Isaak's memory web. Look at the whole tree and judge: does it show the big picture at the right level? If it does, make no changes; if it does not, regroup it.",
);

/**
 * Tidying on the fly (Isaak, 16 Nov): after something new is placed, it judges whether the tree should be regrouped.
 * With nothing just placed it looks at the tree as a whole (the once-only pass after the layers came in).
 */
export async function tidy(justPlaced: string): Promise<{ say: string; touched: string[] }> {
  if (roleDown("web")) return { say: "", touched: [] };
  const outline = await treeOutline();
  const out = await callJson<{ changes?: Change[]; say?: string }>("web", {
    task: "tidy",
    system: justPlaced ? TIDY_SYSTEM : TIDY_WHOLE_SYSTEM,
    prompt: justPlaced ? `JUST PLACED:\n${justPlaced.slice(0, 3000)}\n\nTHE WHOLE WEB:\n${outline}` : `THE WHOLE WEB:\n${outline}`,
    maxTokens: 2500,
  });
  if (!out.changes?.length) return { say: "", touched: [] };
  const touched = await applyChanges(out.changes);
  return { say: String(out.say ?? "").trim(), touched };
}

async function treeOutline(): Promise<string> {
  const all = await db().query<{ id: string; title: string; body: string; is_life: boolean }>(`SELECT id, title, body, is_life FROM summaries WHERE absorbed_at IS NULL ORDER BY created_at`);
  const up = await db().query<{ summary_id: string; input_id: string; input_type: string }>(`SELECT summary_id, input_id, input_type FROM feeds`);
  return all.rows.map((r) => {
    const feedsInto = up.rows.filter((f) => f.input_type === "summary" && f.input_id === r.id).map((f) => f.summary_id);
    const subs = up.rows.filter((f) => f.summary_id === r.id && f.input_type === "summary").length;
    const srcs = up.rows.filter((f) => f.summary_id === r.id && f.input_type === "source").length;
    return `- ${r.id} | ${r.is_life ? "My life (the centre)" : r.title} | ${plain(r.body).replace(/\s+/g, " ").slice(0, 220) || "(empty)"} | made from ${subs} summaries and ${srcs} sources${feedsInto.length ? ` | feeds: ${feedsInto.join(", ")}` : ""}`;
  }).join("\n");
}

/** The tree button: his message changes how the web is organised. */
export async function reviseTree(words: string): Promise<{ say: string; touched: string[] }> {
  const all = await db().query<{ id: string; title: string; body: string; is_life: boolean }>(`SELECT id, title, body, is_life FROM summaries WHERE absorbed_at IS NULL ORDER BY created_at`);
  const up = await db().query<{ summary_id: string; input_id: string; input_type: string }>(`SELECT summary_id, input_id, input_type FROM feeds`);
  const outline = all.rows.map((r) => {
    const feedsInto = up.rows.filter((f) => f.input_type === "summary" && f.input_id === r.id).map((f) => f.summary_id);
    const subs = up.rows.filter((f) => f.summary_id === r.id && f.input_type === "summary").length;
    const srcs = up.rows.filter((f) => f.summary_id === r.id && f.input_type === "source").length;
    return `- ${r.id} | ${r.is_life ? "My life (the centre)" : r.title} | ${plain(r.body).replace(/\s+/g, " ").slice(0, 220) || "(empty)"} | made from ${subs} summaries and ${srcs} sources${feedsInto.length ? ` | feeds: ${feedsInto.join(", ")}` : ""}`;
  }).join("\n");
  light(all.rows.map((r) => r.id));
  const pick = await callJson<{ read?: string[] }>("web", {
    task: "tree-candidates",
    system: `Isaak wants his memory web reorganised. From the whole web, pick the summaries you need to read in full to do what he asks. Answer with one JSON object: {"read": ["summary ids"]}`,
    prompt: `ISAAK: ${words}\n\nTHE WHOLE WEB:\n${outline}`,
    maxTokens: 800,
  });
  const known = new Set(all.rows.map((r) => r.id));
  const read = (pick.read ?? []).filter((x) => known.has(x)).slice(0, 15);
  light(read);
  const full: string[] = [];
  for (const rid of read) {
    const row = all.rows.find((r) => r.id === rid)!;
    const inputs = up.rows.filter((f) => f.summary_id === rid).map((f) => `${f.input_type === "summary" ? "m" : "s"}:${f.input_id}`);
    full.push(`${rid} | ${row.is_life ? "My life" : row.title} (inputs: ${inputs.join(", ") || "none"}):\n${(await annotate(row.body)) || "(empty)"}`);
  }
  const out = await callJson<{ changes?: Change[]; say?: string }>("web", {
    task: "tree",
    system: TREE_SYSTEM,
    prompt: `ISAAK: ${words}\n\nTHE WHOLE WEB:\n${outline}${full.length ? `\n\nREAD IN FULL:\n${full.join("\n\n")}` : ""}`,
    maxTokens: 4000,
  });
  const touched = await applyChanges(out.changes ?? []);
  return { say: String(out.say ?? "").trim() || (touched.length ? "Done." : "I didn't change anything."), touched };
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

/** Where a summary is now: itself, or (merged or absorbed) wherever it went, followed to the end. */
export async function followTrail(summaryId: string): Promise<string[]> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = async (sid: string, depth: number): Promise<void> => {
    if (seen.has(sid) || depth > 20) return;
    seen.add(sid);
    const r = (await db().query<{ absorbed_at: string | null; went_into: string }>(`SELECT absorbed_at, went_into FROM summaries WHERE id = $1`, [sid])).rows[0];
    if (!r) return;
    if (!r.absorbed_at) { out.add(sid); return; }
    for (const next of r.went_into.split(",").filter(Boolean)) await walk(next, depth + 1);
  };
  await walk(summaryId, 0);
  return [...out];
}

/** Every raw source under a summary: what feeds it directly and what feeds the summaries under it. */
export async function sourcesUnder(summaryId: string): Promise<{ id: string; title: string; kind: string; created_at: string }[]> {
  const found = new Set<string>();
  const seen = new Set<string>();
  const walk = async (sid: string): Promise<void> => {
    if (seen.has(sid)) return;
    seen.add(sid);
    for (const i of await inputsOf(sid)) {
      if (i.type === "source") found.add(i.id);
      else await walk(i.id);
    }
  };
  await walk(summaryId);
  if (!found.size) return [];
  const r = await db().query<{ id: string; title: string; file_name: string | null; kind: string; text: string; created_at: string }>(
    `SELECT id, title, file_name, kind, left(text, 80) AS text, created_at FROM sources WHERE id = ANY($1) ORDER BY created_at`, [[...found]]);
  return r.rows.map((row) => ({ id: row.id, title: row.title || row.file_name || row.text.replace(/\s+/g, " ") || row.kind, kind: row.kind, created_at: row.created_at }));
}
