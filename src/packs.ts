import { id } from "./ids.js";
import { callJson } from "./models.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { bump, db, light } from "./state.js";
import { annotate, ensureLife, followTrail, plain, poolText, readSummaries, sourcesUnder, tagTail, taggedWith } from "./web.js";

/**
 * Context packs (IDEA.md): made from a prompt ("gather a context pack on this and this"), stored in the Lego folder for
 * later use, opened and edited by him. A workspace reads the web only through context packs.
 */

export interface Pack { id: string; title: string; prompt: string; description: string; content: string; items: string; created_at: string; updated_at: string }

/** What a pack gathered: the summaries, each with the raw sources under it. */
export interface PackItem { id: string; title: string; text?: string; tag?: string; sources: { id: string; title: string }[] }

export type PackVersion = "current" | "snapshot";

export async function listPacks(): Promise<Pack[]> {
  return (await db().query<Pack>(`SELECT * FROM packs ORDER BY created_at DESC LIMIT 500`)).rows;
}

export async function getPack(packId: string): Promise<Pack> {
  const r = await db().query<Pack>(`SELECT * FROM packs WHERE id = $1`, [packId]);
  if (!r.rows[0]) throw new NotFoundError("No such context pack.");
  return r.rows[0];
}

function itemsOf(p: Pack): PackItem[] {
  try { const v = JSON.parse(p.items); return Array.isArray(v) ? v : []; } catch { return []; }
}

export async function editPack(packId: string, content: string, title?: string): Promise<void> {
  const p = await getPack(packId);
  await db().query(`UPDATE packs SET content = $2, title = $3, updated_at = now() WHERE id = $1`, [packId, content, (title ?? p.title).trim().slice(0, 200) || p.title]);
  bump();
}

const RAW_NOTE = "The raw sources each summary was made from are listed under it, as a reality check. You don't have to read them; to open one, write OPEN s:ID on a line of its own and you will get its full text.";

function sourceLines(sources: { id: string; title: string }[], shown: Set<string>): string {
  const lines: string[] = [];
  for (const src of sources) {
    lines.push(`- s:${src.id} ${src.title.slice(0, 100)}${shown.has(src.id) ? " (also listed above)" : ""}`);
    shown.add(src.id);
  }
  return lines.length ? `Raw sources:\n${lines.join("\n")}` : "Raw sources: (none)";
}

/**
 * Context packs (Isaak, 16 Nov): it gathers summaries, attaches every raw source under them, and writes a short
 * description. The pack keeps the version as gathered (a snapshot with its date) and can be read as it is now.
 */
export async function buildPack(title: string, prompt: string): Promise<string> {
  if (!prompt.trim()) throw new ValidationError("Say what the context pack should be about.");
  const lifeId = await ensureLife();
  const all = await db().query<{ id: string; title: string; body: string; kind: string; tags: string }>(
    `SELECT id, title, body, kind, tags FROM summaries WHERE absorbed_at IS NULL ORDER BY updated_at DESC LIMIT 400`);
  const outline = all.rows.map((s) => `- ${s.id} | ${s.title}${s.kind === "project" ? " (project)" : ""} | ${plain(s.body).slice(0, 200) || "(empty)"}${tagTail(s.tags)}`).join("\n");
  const out = await callJson<{ title?: string; pick?: string[]; tags?: string[] }>("web", {
    task: "pack",
    system: `You gather a context pack from Isaak's memory web for a model that will work on something. Pick the summaries that give that model what it needs: enough to understand, nothing that only distracts. You can also pick tags: a tag brings in every summary and every raw entry (message, file, email) that carries it, wherever it sits in the web. "My life" is ${lifeId}. Answer with one JSON object: {"title": "a short title", "pick": ["summary ids"], "tags": ["tags from the pool"]}`,
    prompt: `WHAT THE PACK IS FOR: ${prompt}\n\nTHE SUMMARIES:\n${outline || "(the web is still empty)"}\n\nTAGS IN THE POOL (how often each is used):\n${await poolText()}`,
    maxTokens: 2000,
  });
  const known = new Set(all.rows.map((s) => s.id));
  const byTag: { tag: string; sources: { id: string; title: string }[] }[] = [];
  const fromTags: string[] = [];
  for (const t of (out.tags ?? []).map(String)) {
    const hit = await taggedWith(t);
    if (!hit.summaries.length && !hit.sources.length) continue;
    fromTags.push(...hit.summaries.map((x) => x.id));
    byTag.push({ tag: t, sources: hit.sources.map((x) => ({ id: x.id, title: x.title })) });
  }
  const picked = [...new Set([...(out.pick ?? []).filter((p) => known.has(p)), ...fromTags.filter((p) => known.has(p))])];
  const read = await readSummaries(picked);
  const items: PackItem[] = [];
  const parts: string[] = [];
  const shown = new Set<string>();
  for (const r of read) {
    const sources = (await sourcesUnder(r.id)).map((x) => ({ id: x.id, title: x.title }));
    const text = await annotate(r.body);
    items.push({ id: r.id, title: r.title, text, sources });
    parts.push(`## ${r.title}\n${text}\n\n${sourceLines(sources, shown)}`);
  }
  // Raw entries a tag brought in that none of the gathered summaries already lists.
  for (const bt of byTag) {
    const extra = bt.sources.filter((x) => !shown.has(x.id));
    if (!extra.length) continue;
    items.push({ id: `tag:${bt.tag}`, title: `Everything tagged "${bt.tag}"`, tag: bt.tag, sources: extra });
    parts.push(`## Everything tagged "${bt.tag}"\n${sourceLines(extra, shown)}`);
  }
  const packTitle = (title.trim() || String(out.title ?? "") || prompt).slice(0, 200);
  const desc = read.length ? await callJson<{ description?: string }>("web", {
    task: "pack-description",
    system: `You just gathered a context pack from Isaak's memory web. Write a short description of what is in it, for Isaak: a few sentences, plain. Answer with one JSON object: {"description": ""}`,
    prompt: `WHAT THE PACK IS FOR: ${prompt}\n\nWHAT IT GATHERED:\n${parts.join("\n\n").slice(0, 20000)}`,
    maxTokens: 600,
  }).catch(() => ({ description: "" })) : { description: "Nothing in the web fitted yet." };
  const content = [`CONTEXT PACK: ${prompt}`, RAW_NOTE, ...parts].join("\n\n");
  const packId = id();
  await db().query(`INSERT INTO packs (id, title, prompt, description, content, items) VALUES ($1,$2,$3,$4,$5,$6)`,
    [packId, packTitle, prompt, String(desc.description ?? "").trim(), content, JSON.stringify(items)]);
  light(picked);
  bump();
  return packId;
}

/**
 * A pack as a model reads it. "snapshot": as it was gathered (or as he edited it). "current": the same summaries as
 * they are now, following merges and absorbs to wherever they went, with the raw sources under them now.
 */
export async function packText(packId: string, version: PackVersion = "current"): Promise<string> {
  const p = await getPack(packId);
  const date = new Date(p.created_at).toISOString().slice(0, 10);
  if (version === "snapshot" || !itemsOf(p).length) return `${p.content}\n\n(This pack as it was gathered on ${date}.)`;
  const now = await currentItems(p);
  const parts: string[] = [];
  const shown = new Set<string>();
  for (const it of now) {
    if (it.id.startsWith("tag:")) { parts.push(`## ${it.title}\n${sourceLines(it.sources, shown)}`); continue; }
    if (it.gone) { parts.push(`## ${it.title} (no longer in the web; as it was gathered)\n${it.snapshot}`); continue; }
    parts.push(`## ${it.title}${it.note ? ` (${it.note})` : ""}\n${await annotate(it.body)}\n\n${sourceLines(it.sources, shown)}`);
  }
  return [`CONTEXT PACK: ${p.prompt} (gathered ${date}; this is its current version)`, RAW_NOTE, ...parts].join("\n\n");
}

async function currentItems(p: Pack): Promise<{ id: string; title: string; body: string; note: string; gone: boolean; snapshot: string; sources: { id: string; title: string }[] }[]> {
  const out: Awaited<ReturnType<typeof currentItems>> = [];
  const done = new Set<string>();
  for (const it of itemsOf(p)) {
    if (it.tag) {
      const hit = await taggedWith(it.tag);
      out.push({ id: it.id, title: it.title, body: "", note: "", gone: false, snapshot: "", sources: hit.sources.map((x) => ({ id: x.id, title: x.title })) });
      continue;
    }
    const now = await followTrail(it.id);
    if (!now.length) {
      out.push({ id: it.id, title: it.title, body: "", note: "", gone: true, snapshot: it.text?.trim() || "(no text kept)", sources: it.sources });
      continue;
    }
    const read = await readSummaries(now.filter((x) => !done.has(x)));
    for (const r of read) {
      done.add(r.id);
      const note = r.id === it.id ? "" : `"${it.title}" went into this one`;
      out.push({ id: r.id, title: r.title, body: r.body, note, gone: false, snapshot: "", sources: (await sourcesUnder(r.id)).map((x) => ({ id: x.id, title: x.title })) });
    }
  }
  return out;
}

/** A pack for him to look at: both versions side by side. */
export async function packView(packId: string) {
  const p = await getPack(packId);
  const now = itemsOf(p).length ? await currentItems(p) : [];
  return {
    ...p, items: itemsOf(p),
    current: now.map((x) => ({ id: x.id, title: x.title, note: x.gone ? "no longer in the web" : x.note, gone: x.gone, sources: x.sources })),
  };
}

/** Raw sources a model asked to open, limited to those its packs list. */
export async function openSources(ids: string[], allowed: Set<string>): Promise<string> {
  const ok = ids.filter((x) => allowed.has(x)).slice(0, 10);
  if (!ok.length) return "";
  const r = await db().query<{ id: string; title: string; text: string; readable: boolean; created_at: string }>(`SELECT id, title, text, readable, created_at FROM sources WHERE id = ANY($1)`, [ok]);
  return r.rows.map((row) => `### s:${row.id} ${row.title} (${new Date(row.created_at).toISOString().slice(0, 10)})\n${row.readable ? row.text.slice(0, 30000) : "(a file that can't be read as text yet)"}`).join("\n\n");
}
