import { z } from "zod";
import type { Db } from "../db.js";
import type { Router } from "../ai/router.js";
import { completeJson } from "../ai/tracked.js";
import { getSettings, logAction } from "../repo.js";
import { addEntry, addMoment, addSource, addStream, createBrick, findByName, linkBricks, listBricks, updateBrick, type Brick } from "./store.js";

/**
 * Intake: everything that comes in is kept whole in the stream and broken into small bricks, one thing each.
 * Code decides that this happens; the model decides what the things are and how they relate. It never reads the whole
 * map: it sees the list of brick names (cheap) and the new text.
 */

/** Which model does a background job. Intake and sessions run on a mid-size model in the playtest (quality first, cost measured). */
export async function brainModel(db: Db, userId: string, job: "intake" | "session" | "night"): Promise<string> {
  const settings = await getSettings(db, userId);
  if (settings.provider === "mock") return "mock-cheap";
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "claude-sonnet-5-5";
  void job;
  return "gemini-2.5-flash";
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

export interface IntakeResult { sourceId: string | null; streamId: string; created: string[]; touched: string[]; links: number }

export async function intake(
  db: Db,
  ai: Router,
  userId: string,
  input: { text: string; kind: "chat" | "file" | "gemini"; title?: string; origin?: "his" | "web" | "own"; onProgress?: (part: number, of: number) => void | Promise<void> },
): Promise<IntakeResult> {
  const text = input.text.trim();
  const sourceId = input.kind === "chat" ? null : await addSource(db, userId, { kind: input.kind, title: input.title || "untitled", body: text });
  const streamId = await addStream(db, userId, { kind: input.kind, sourceId, content: text });
  const result: IntakeResult = { sourceId, streamId, created: [], touched: [], links: 0 };
  if (!text) return result;
  const who = (await db.query(`SELECT name FROM users WHERE id = $1`, [userId])).rows[0];
  const name = String(who?.name ?? "Isaak");
  const model = await brainModel(db, userId, "intake");
  // A file gets a brick of its own; everything found in it hangs off it, weakly ("same source").
  const sourceBrick = sourceId ? await createBrick(db, userId, { name: input.title || "untitled file", kind: "source", origin: "his", summary: `${input.kind === "gemini" ? "Gemini conversation" : "File"} he handed over, ${text.length} characters.`, sourceId }) : null;
  if (sourceBrick) result.created.push(sourceBrick);
  const origin = input.origin ?? "his";
  const chunks = chunkText(text);
  for (const [index, chunk] of chunks.entries()) {
    // Long files take a while; telling the page keeps the connection alive and shows what is happening.
    await input.onProgress?.(index + 1, chunks.length);
    const bricks = await listBricks(db, userId);
    let parsed: z.output<typeof intakeSchema>;
    try {
      parsed = (await completeJson(db, userId, ai, {
        role: "filing",
        model,
        maxTokens: 12_000,
        system: intakePrompt(name),
        messages: [{ role: "user", content: `THE BRICK LIST:\n${brickList(bricks)}\n\nNEW TEXT (${input.kind}${input.title ? `: ${input.title}` : ""}):\n${chunk}\nEND NEW TEXT` }],
      }, intakeSchema, { jobKind: "intake" })) as z.output<typeof intakeSchema>;
    } catch (error) {
      await logAction(db, userId, { what: "intake failed", why: error instanceof Error ? error.message.slice(0, 300) : "unknown", source: "intake", payload: { streamId } });
      continue;
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
  await logAction(db, userId, { what: "filed into the web", why: `${result.created.length} new bricks, ${result.touched.length} existing ones grew, ${result.links} links`, source: "intake", payload: { streamId, sourceId } });
  return result;
}
