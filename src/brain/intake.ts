import { z } from "zod";
import type { Db } from "../db.js";
import type { Router } from "../ai/router.js";
import { completeJson } from "../ai/tracked.js";
import { getSettings, logAction } from "../repo.js";
import { planAvailable } from "../ai/plan.js";
import { addEntry, addMoment, addSource, addStream, createBrick, findByName, linkBricks, listBricks, updateBrick, type Brick } from "./store.js";

/**
 * Intake: everything that comes in is kept whole in the stream and broken into small bricks, one thing each.
 * Code decides that this happens; the model decides what the things are and how they relate. It never reads the whole
 * map: it sees the list of brick names (cheap) and the new text.
 */

/**
 * Which model does a background job. The cheap model by default: these run on everything that comes in, for years.
 * BRAIN_MODEL in the environment overrides it (to compare quality, say).
 */
export async function brainModel(db: Db, userId: string, job: "intake" | "session" | "night"): Promise<string> {
  const settings = await getSettings(db, userId);
  if (settings.provider === "mock") return "mock-cheap";
  if (process.env.BRAIN_MODEL?.trim()) return process.env.BRAIN_MODEL.trim();
  // On Hub of Me's own plan a call costs no money, so filing and sessions get the mid-size model; on the API, the cheap one.
  if (planAvailable()) return "claude-sonnet-5-5";
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "claude-haiku-5-5";
  void job;
  return "gemini-3.5-flash-lite";
}

const CHUNK_CHARS = 5000;

export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const paragraphs = text.split(/\n(?=\s*\n)|\n(?=\s*[-*•\d])/);
  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if ((current + p).length > size && current.trim()) { chunks.push(current.trim()); current = ""; }
    if (p.length > size) {
      for (let i = 0; i < p.length; i += size) chunks.push(p.slice(i, i + size).trim());
      continue;
    }
    current += `${p}\n`;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

const asStr = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));
const intakeSchema = z.preprocess(
  (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : { items: Array.isArray(v) ? v : [] }),
  z.object({
    items: z.array(z.object({
      ref: z.preprocess(asStr, z.string()).optional(),
      name: z.preprocess(asStr, z.string()),
      kind: z.preprocess(asStr, z.string()).optional(),
      summary: z.preprocess(asStr, z.string()).optional(),
      quote: z.preprocess(asStr, z.string()).optional(),
      group: z.preprocess((v) => (v == null ? undefined : String(v)), z.string()).optional(),
      contact: z.preprocess(asStr, z.string()).optional(),
      entries: z.array(z.object({ kind: z.preprocess(asStr, z.string()), text: z.preprocess(asStr, z.string()) })).optional(),
    })).default([]),
    links: z.array(z.object({
      a: z.preprocess(asStr, z.string()),
      b: z.preprocess(asStr, z.string()),
      type: z.preprocess(asStr, z.string()).optional(),
      reason: z.preprocess(asStr, z.string()).optional(),
    })).default([]),
  }),
);

function intakePrompt(name: string): string {
  return `TASK: intake
You file what ${name} sends into a web of small bricks. One brick is one thing: a person, place, organisation, project, term, question, idea, event, plan, feeling or topic. Be granular: a page of notes gives 20 to 30 bricks. Rambling dumps and tidy notes are read the same way: by meaning, not layout.

For every thing the text mentions:
- If a brick in THE BRICK LIST already means it, use its id as ref (do not make a duplicate; a nickname or a longer name for the same thing is the same brick).
- Otherwise give a short, plain name that could not be mistaken for another thing (no ref): "Internship at Wetlands International", not "internship"; the full name of an organisation, not only its initials.
- quote: his exact words where it comes up (copy them).
- group: a number; things that come up in the same sentence or line share a group.
- entries: what the text says about it, each as {kind, text}: kind is fact, question (something he asks or wonders), lead (something to look into or sign up for), idea, todo, feeling, or conclusion. Keep his meaning; don't add your own guesses.
- summary (new bricks only): one or two plain sentences of what it is, from the text.
- kind: person, place, org, project, term, question, idea, event, plan, feeling, topic, or thing.
- contact (people only): contact details that appear in the text itself. Never invent them.

links: pairs that relate in a way the text shows or that is plainly true, with a short reason: type "about" (one is part of or about the other) or "meaning" (close in meaning though not said together). Use refs or names. Things in the same group are linked automatically; don't repeat those.

Return JSON: {"items":[{"ref":"","name":"","kind":"","summary":"","quote":"","group":1,"contact":"","entries":[{"kind":"","text":""}]}],"links":[{"a":"","b":"","type":"about","reason":""}]}`;
}

function brickList(bricks: Brick[]): string {
  if (!bricks.length) return "(empty: this is the first thing that came in)";
  return bricks.map((b) => `[${b.id}] ${b.name} (${b.kind})${b.summary ? `: ${b.summary.slice(0, 90)}` : ""}`).join("\n");
}

export interface IntakeResult {
  sourceId: string | null;
  streamId: string;
  created: string[];
  touched: string[];
  links: number;
  /** Parts that could not be filed this time; they are kept and retried later. */
  failed: { part: number; of: number; error: string }[];
  /** The same file was handed over before and was already filed in full. */
  already: boolean;
}

type Origin = "his" | "web" | "own";
type Kind = "chat" | "file" | "gemini" | "own";

export async function intake(
  db: Db,
  ai: Router,
  userId: string,
  input: { text: string; kind: Kind; title?: string; origin?: Origin; onProgress?: (part: number, of: number) => void | Promise<void> },
): Promise<IntakeResult> {
  const text = input.text.trim();
  // The same file handed over again is the same source: no second copy, no second filing. Parts that failed before are retried.
  if (input.kind !== "chat" && text) {
    const seen = (await db.query(
      `SELECT s.id AS source_id, st.id AS stream_id, st.failed_parts FROM brain_sources s JOIN brain_stream st ON st.source_id = s.id AND st.archived_at IS NULL
       WHERE s.user_id = $1 AND s.title = $2 AND s.body = $3 AND s.archived_at IS NULL ORDER BY s.created_at LIMIT 1`,
      [userId, (input.title || "untitled").slice(0, 300), text],
    )).rows[0];
    if (seen) {
      const failedParts = parseParts(seen.failed_parts);
      const result: IntakeResult = { sourceId: String(seen.source_id), streamId: String(seen.stream_id), created: [], touched: [], links: 0, failed: [], already: failedParts.length === 0 };
      if (!failedParts.length) return result;
      return fileParts(db, ai, userId, { ...input, text, sourceId: result.sourceId, streamId: result.streamId, parts: failedParts }, result);
    }
  }
  const sourceId = input.kind === "chat" ? null : await addSource(db, userId, { kind: input.kind, title: input.title || "untitled", body: text });
  const streamId = await addStream(db, userId, { kind: input.kind, sourceId, content: text });
  const result: IntakeResult = { sourceId, streamId, created: [], touched: [], links: 0, failed: [], already: false };
  if (!text) return result;
  // A file gets a brick of its own; everything found in it hangs off it, weakly ("same source").
  if (sourceId) result.created.push(await createBrick(db, userId, { name: input.title || "untitled file", kind: "source", origin: "his", summary: `${input.kind === "gemini" ? "Gemini conversation" : "File"} he handed over, ${text.length} characters.`, sourceId }));
  return fileParts(db, ai, userId, { ...input, text, sourceId, streamId, parts: null }, result);
}

function parseParts(value: unknown): number[] {
  try { const v = JSON.parse(String(value ?? "[]")); return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n >= 0) : []; } catch { return []; }
}

/** Retry the parts of earlier texts that could not be filed (no credit, a provider error). Called before each turn. */
export async function retryFailedIntake(db: Db, ai: Router, userId: string, onProgress?: (title: string, part: number, of: number) => void | Promise<void>): Promise<IntakeResult[]> {
  const rows = (await db.query(
    `SELECT st.id, st.kind, st.content, st.source_id, st.failed_parts, s.title FROM brain_stream st LEFT JOIN brain_sources s ON s.id = st.source_id
     WHERE st.user_id = $1 AND st.archived_at IS NULL AND st.failed_parts <> '[]' AND st.retries < 5 ORDER BY st.created_at`,
    [userId],
  )).rows;
  const results: IntakeResult[] = [];
  for (const row of rows) {
    const parts = parseParts(row.failed_parts);
    if (!parts.length) continue;
    await db.query(`UPDATE brain_stream SET retries = retries + 1 WHERE id = $1`, [row.id]);
    const title = row.title ? String(row.title) : "";
    const result: IntakeResult = { sourceId: row.source_id ? String(row.source_id) : null, streamId: String(row.id), created: [], touched: [], links: 0, failed: [], already: false };
    results.push(await fileParts(db, ai, userId, { text: String(row.content), kind: String(row.kind) as Kind, title, sourceId: result.sourceId, streamId: result.streamId, parts, onProgress: onProgress ? (p, of) => onProgress(title || "your message", p, of) : undefined }, result));
    if (result.failed.length) break; // still failing: try again next time, without spending more calls now
  }
  return results;
}

async function fileParts(
  db: Db,
  ai: Router,
  userId: string,
  input: { text: string; kind: Kind; title?: string; origin?: Origin; sourceId: string | null; streamId: string; parts: number[] | null; onProgress?: (part: number, of: number) => void | Promise<void> },
  result: IntakeResult,
): Promise<IntakeResult> {
  const { text, sourceId, streamId } = input;
  const who = (await db.query(`SELECT name FROM users WHERE id = $1`, [userId])).rows[0];
  const name = String(who?.name ?? "Isaak");
  const model = await brainModel(db, userId, "intake");
  const sourceBrick = sourceId ? String((await db.query(`SELECT id FROM bricks WHERE user_id = $1 AND kind = 'source' AND source_id = $2 AND archived_at IS NULL LIMIT 1`, [userId, sourceId])).rows[0]?.id ?? "") || null : null;
  const origin = input.origin ?? "his";
  const chunks = chunkText(text);
  const todo = input.parts ?? chunks.map((_, i) => i);
  const failedNow: number[] = [];
  for (const index of todo) {
    const chunk = chunks[index];
    if (chunk == null) continue;
    // Long files take a while; telling the page keeps the connection alive and shows what is happening.
    await input.onProgress?.(index + 1, chunks.length);
    const bricks = await listBricks(db, userId);
    let parsed: z.output<typeof intakeSchema>;
    try {
      parsed = (await completeJson(db, userId, ai, {
        role: "filing",
        model,
        maxTokens: 12_000,
        system: input.kind === "own" ? `${intakePrompt(name)}\n\nTHIS TEXT IS THE AI'S OWN NOTES, not ${name}'s words. File it the same way, but nothing in it is evidence about him: quotes are its own words, and entries are its conclusions, guesses and open questions.` : intakePrompt(name),
        messages: [{ role: "user", content: `THE BRICK LIST:\n${brickList(bricks)}\n\nNEW TEXT (${input.kind}${input.title ? `: ${input.title}` : ""}):\n${chunk}\nEND NEW TEXT` }],
      }, intakeSchema, { jobKind: "intake" })) as z.output<typeof intakeSchema>;
    } catch (error) {
      const why = error instanceof Error ? error.message.slice(0, 300) : "unknown";
      failedNow.push(index);
      result.failed.push({ part: index + 1, of: chunks.length, error: why });
      await logAction(db, userId, { what: "intake failed", why: `part ${index + 1} of ${chunks.length}${input.title ? ` of ${input.title}` : ""}: ${why}`, source: "intake", payload: { streamId } });
      // The same cause (no credit, provider down) will fail the rest too: keep them all for the retry instead of spending calls.
      for (const rest of todo.slice(todo.indexOf(index) + 1)) if (chunks[rest] != null) failedNow.push(rest);
      break;
    }
    if (!parsed.items.length && chunk.length > 400) {
      await logAction(db, userId, { what: "intake found nothing", why: `part ${index + 1} of ${chunks.length} gave no bricks`, source: "intake", payload: { streamId } });
    }
    const idByKey = new Map<string, string>();
    const groups = new Map<string, string[]>();
    for (const item of parsed.items) {
      if (!item.name?.trim()) continue;
      const fresh = await listBricks(db, userId);
      const ref = item.ref?.trim() ?? "";
      const existing = (ref && fresh.find((b) => b.id === ref)) || findByName(fresh, item.name);
      let brickId: string;
      if (existing) {
        brickId = existing.id;
        if (!result.touched.includes(brickId) && !result.created.includes(brickId)) result.touched.push(brickId);
        if (item.contact?.trim()) await updateBrick(db, userId, brickId, { contact: item.contact });
        if (!existing.summary && item.summary?.trim()) await updateBrick(db, userId, brickId, { summary: item.summary });
      } else {
        brickId = await createBrick(db, userId, { name: item.name, kind: item.kind, origin, summary: item.summary, contact: item.contact, sourceId });
        result.created.push(brickId);
      }
      idByKey.set(item.name.trim().toLowerCase(), brickId);
      if (item.ref) idByKey.set(item.ref.trim(), brickId);
      await addMoment(db, userId, { brickId, streamId, sourceId, quote: item.quote?.trim() || item.name });
      for (const entry of item.entries ?? []) if (entry.text?.trim()) await addEntry(db, userId, { brickId, kind: entry.kind.toLowerCase(), text: entry.text, origin, streamId });
      if (item.group) (groups.get(item.group) ?? groups.set(item.group, []).get(item.group)!).push(brickId);
      if (sourceBrick && brickId !== sourceBrick) await linkBricks(db, userId, { a: brickId, b: sourceBrick, type: "source", strength: 0.3, reason: "same source" });
    }
    for (const members of groups.values()) {
      const uniq = [...new Set(members)];
      for (let i = 0; i < uniq.length; i += 1) for (let j = i + 1; j < uniq.length; j += 1) { await linkBricks(db, userId, { a: uniq[i], b: uniq[j], type: "together", strength: 1, reason: "came up together" }); result.links += 1; }
    }
    const all = await listBricks(db, userId);
    const resolve = (ref: string) => idByKey.get(ref.trim()) ?? idByKey.get(ref.trim().toLowerCase()) ?? all.find((b) => b.id === ref.trim())?.id ?? findByName(all, ref)?.id;
    for (const l of parsed.links) {
      const a = resolve(l.a), b = resolve(l.b);
      if (!a || !b) continue;
      const type = l.type === "meaning" ? "meaning" : "about";
      await linkBricks(db, userId, { a, b, type, strength: type === "about" ? 1.5 : 1, reason: l.reason ?? "", madeBy: "intake" });
      result.links += 1;
    }
  }
  await db.query(`UPDATE brain_stream SET failed_parts = $2, last_error = $3 WHERE id = $1`, [streamId, JSON.stringify(failedNow), result.failed[0]?.error ?? ""]);
  if (failedNow.length) result.failed = [{ part: failedNow[0] + 1, of: chunks.length, error: result.failed[0]?.error ?? "unknown" }];
  const filedParts = todo.length - failedNow.length;
  await logAction(db, userId, {
    what: failedNow.length ? "filed into the web, partly" : "filed into the web",
    why: `${filedParts} of ${todo.length} parts filed${failedNow.length ? ` (${failedNow.length} kept for a retry)` : ""}: ${result.created.length} new bricks, ${result.touched.length} existing ones grew, ${result.links} links`,
    source: "intake",
    payload: { streamId, sourceId },
  });
  return result;
}
