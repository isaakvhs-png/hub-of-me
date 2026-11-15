import { id } from "./ids.js";
import { callJson } from "./models.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { bump, db, light } from "./state.js";
import { annotate, ensureLife, plain, readSummaries } from "./web.js";

/**
 * Context packs (IDEA.md): made from a prompt ("gather a context pack on this and this"), stored in the Lego folder for
 * later use, opened and edited by him. A workspace reads the web only through context packs.
 */

export interface Pack { id: string; title: string; prompt: string; content: string; created_at: string; updated_at: string }

export async function listPacks(): Promise<Pack[]> {
  return (await db().query<Pack>(`SELECT * FROM packs ORDER BY updated_at DESC LIMIT 500`)).rows;
}

export async function getPack(packId: string): Promise<Pack> {
  const r = await db().query<Pack>(`SELECT * FROM packs WHERE id = $1`, [packId]);
  if (!r.rows[0]) throw new NotFoundError("No such context pack.");
  return r.rows[0];
}

export async function editPack(packId: string, content: string, title?: string): Promise<void> {
  const p = await getPack(packId);
  await db().query(`UPDATE packs SET content = $2, title = $3, updated_at = now() WHERE id = $1`, [packId, content, (title ?? p.title).trim().slice(0, 200) || p.title]);
  bump();
}

export async function buildPack(title: string, prompt: string): Promise<string> {
  if (!prompt.trim()) throw new ValidationError("Say what the context pack should be about.");
  const lifeId = await ensureLife();
  const all = await db().query<{ id: string; title: string; body: string; kind: string }>(
    `SELECT id, title, body, kind FROM summaries WHERE absorbed_at IS NULL ORDER BY updated_at DESC LIMIT 400`);
  const outline = all.rows.map((s) => `- ${s.id} | ${s.title}${s.kind === "project" ? " (project)" : ""} | ${plain(s.body).slice(0, 200) || "(empty)"}`).join("\n");
  const out = await callJson<{ title?: string; pick?: string[] }>("web", {
    task: "pack",
    system: `You gather a context pack from Isaak's memory web for a model that will work on something. Pick the summaries that give that model what it needs: enough to understand, nothing that only distracts. "My life" is ${lifeId}. Answer with one JSON object: {"title": "a short title", "pick": ["summary ids"]}`,
    prompt: `WHAT THE PACK IS FOR: ${prompt}\n\nTHE SUMMARIES:\n${outline || "(the web is still empty)"}`,
    maxTokens: 2000,
  });
  const known = new Set(all.rows.map((s) => s.id));
  const picked = (out.pick ?? []).filter((p) => known.has(p)).slice(0, 40);
  const read = await readSummaries(picked);
  const parts: string[] = [];
  for (const r of read) parts.push(`## ${r.title}\n${await annotate(r.body)}`);
  const content = [`CONTEXT PACK: ${prompt}`, ...parts].join("\n\n");
  const packId = id();
  await db().query(`INSERT INTO packs (id, title, prompt, content) VALUES ($1,$2,$3,$4)`, [packId, (title.trim() || String(out.title ?? "") || prompt).slice(0, 200), prompt, content]);
  light(picked);
  bump();
  return packId;
}
