import { createHash } from "node:crypto";
import { sid } from "./store.js";
import type { Ctx } from "./steps.js";

/**
 * Similar meaning (BUILD_SPEC §5.3, §7). Two kinds of vector are kept side by side:
 *  - "local-hash": always, made by code from the words (no network). It catches shared words, not meaning.
 *  - Gemini embeddings when GEMINI_API_KEY is set (privacy accepted on 7 Nov): these catch meaning.
 * A search compares vectors of the same model only; it prefers Gemini when both exist.
 */
const LOCAL = "local-hash-512";
const DIMS = 512;
export const geminiEmbedModel = () => process.env.GEMINI_EMBED_MODEL?.trim() || "gemini-embedding-001";
const key = () => process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || "";

const STOP = new Set("the a an and or of to in on for with at by from is are was were be been it this that these those as not no but if then so do does did have has had i you he she we they my your his her our their me him them what which who when where why how can could would should will just about into over than also very more most some any all".split(" "));

export function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
}

export function localVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of words(text)) {
    const h = createHash("md5").update(w).digest();
    const i = h.readUInt16BE(0) % DIMS;
    v[i] += h[2] & 1 ? 1 : -1;
  }
  return normalise(v);
}

function normalise(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n ? v.map((x) => x / n) : v;
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
}

/** Gemini vectors for several texts at once; null when there is no key or the call fails (the caller records that). */
export async function geminiVectors(texts: string[], fetchImpl: typeof fetch = fetch): Promise<number[][] | null> {
  const apiKey = key();
  if (!apiKey || !texts.length) return null;
  const model = geminiEmbedModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requests: texts.map((text) => ({ model: `models/${model}`, content: { parts: [{ text: text.slice(0, 8000) }] } })) }),
  });
  if (!response.ok) throw new Error(`Gemini embeddings failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as { embeddings?: { values?: number[] }[] };
  return (body.embeddings ?? []).map((e) => normalise(e.values ?? []));
}

const hash = (t: string) => createHash("sha1").update(t).digest("hex").slice(0, 16);

export interface EmbedResult { local: number; gemini: number; geminiError?: string }

/** Keep vectors for these owners (bricks, pages, source chunks). Unchanged text is not embedded again. */
export async function embedOwners(ctx: Ctx, items: { kind: "brick" | "page" | "chunk" | "request"; id: string; text: string }[]): Promise<EmbedResult> {
  const out: EmbedResult = { local: 0, gemini: 0 };
  const todoGemini: typeof items = [];
  for (const item of items) {
    const h = hash(item.text);
    const existing = await ctx.db.query<{ model: string; text_hash: string; id: string }>(`SELECT id, model, text_hash FROM embeddings WHERE user_id=$1 AND owner_kind=$2 AND owner_id=$3 AND archived_at IS NULL`, [ctx.userId, item.kind, item.id]);
    const local = existing.rows.find((r) => r.model === LOCAL);
    if (!local || local.text_hash !== h) {
      if (local) await ctx.db.query(`UPDATE embeddings SET archived_at=now() WHERE id=$1`, [local.id]);
      await ctx.db.query(`INSERT INTO embeddings (id, user_id, owner_kind, owner_id, model, vector, text_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sid(), ctx.userId, item.kind, item.id, LOCAL, JSON.stringify(localVector(item.text).map((x) => Math.round(x * 1e4) / 1e4)), h]);
      out.local += 1;
    }
    const g = existing.rows.find((r) => r.model === geminiEmbedModel());
    if (key() && (!g || g.text_hash !== h)) todoGemini.push(item);
  }
  if (todoGemini.length) {
    try {
      for (let i = 0; i < todoGemini.length; i += 50) {
        const batch = todoGemini.slice(i, i + 50);
        const vectors = await geminiVectors(batch.map((b) => b.text));
        if (!vectors) break;
        for (let j = 0; j < batch.length; j += 1) {
          await ctx.db.query(`UPDATE embeddings SET archived_at=now() WHERE user_id=$1 AND owner_kind=$2 AND owner_id=$3 AND model=$4 AND archived_at IS NULL`, [ctx.userId, batch[j].kind, batch[j].id, geminiEmbedModel()]);
          await ctx.db.query(`INSERT INTO embeddings (id, user_id, owner_kind, owner_id, model, vector, text_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [sid(), ctx.userId, batch[j].kind, batch[j].id, geminiEmbedModel(), JSON.stringify(vectors[j]), hash(batch[j].text)]);
          out.gemini += 1;
        }
      }
    } catch (error) {
      out.geminiError = error instanceof Error ? error.message : String(error);
    }
  }
  return out;
}

export interface Similar { kind: string; id: string; score: number; model: string }

/** The owners closest in meaning to a text. */
export async function similarTo(ctx: Ctx, text: string, opts: { limit?: number; kinds?: string[]; exclude?: string[] } = {}): Promise<{ hits: Similar[]; model: string; note?: string }> {
  const limit = opts.limit ?? 12;
  let model = LOCAL;
  let query: number[] = localVector(text);
  let note: string | undefined;
  if (key()) {
    const have = await ctx.db.query(`SELECT 1 FROM embeddings WHERE user_id=$1 AND model=$2 AND archived_at IS NULL LIMIT 1`, [ctx.userId, geminiEmbedModel()]);
    if (have.rows.length) {
      try {
        const v = await geminiVectors([text]);
        if (v?.[0]?.length) { query = v[0]; model = geminiEmbedModel(); }
      } catch (error) {
        note = `Gemini embeddings failed, fell back to shared words: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  const kinds = opts.kinds ?? ["brick", "page", "chunk"];
  const rows = await ctx.db.query<{ owner_kind: string; owner_id: string; vector: string }>(
    `SELECT owner_kind, owner_id, vector FROM embeddings WHERE user_id=$1 AND model=$2 AND archived_at IS NULL AND owner_kind = ANY($3::text[])`, [ctx.userId, model, kinds]);
  const exclude = new Set(opts.exclude ?? []);
  const hits = rows.rows
    .filter((r) => !exclude.has(r.owner_id))
    .map((r) => ({ kind: r.owner_kind, id: r.owner_id, score: cosine(query, JSON.parse(r.vector) as number[]), model }))
    .filter((h) => h.score > (model === LOCAL ? 0.15 : 0.5))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { hits, model, note };
}
