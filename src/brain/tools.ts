import type { Db } from "../db.js";
import { addAgenda, addEntry, brickDetail, closeAgenda, createBrick, getBrick, getSource, linkBricks, setEntryStatus, updateAgendaStep, updateBrick } from "./store.js";

/** Tools for the web. Shared by conversation turns and work sessions. Returns null when the tool is not one of these. */

export const BRAIN_TOOLS = [
  { name: "open_brick", effort: "light", description: "See one brick in full: summary, contact, every moment with his words, every entry, every link. input: { id }." },
  { name: "open_source", effort: "light", description: "Read a whole file or Gemini import he handed over (a source brick points to it). input: { id } (the source id, sXXXXX)." },
  { name: "brick_new", effort: "light", description: "Make a new brick: something you found or thought that deserves its own place. input: { name, kind, summary, origin: \"own\" (your thought) or \"web\" (found in a source), entries: [{kind, text}], links: [{id, type: \"about\"|\"meaning\"|\"insight\", reason}] }." },
  { name: "brick_add", effort: "light", description: "Add to a brick: new entries (kind: fact, question, lead, idea, todo, conclusion), contact details, or a summary if it has none. Entries are added, never rewritten. input: { id, entries: [{kind, text, origin: \"own\"|\"web\"}], contact, summary }." },
  { name: "entry_close", effort: "light", description: "Close an entry: a question answered, a lead followed, a to-do done, or dropped with a reason. A concrete win. input: { id, status: \"answered\"|\"done\"|\"dropped\", note }." },
  { name: "link", effort: "light", description: "Lay a link between two bricks. Use type \"insight\" for a connection across the map that matters, with the reason written in. input: { a, b, type: \"insight\"|\"about\"|\"meaning\", reason }." },
  { name: "agenda_add", effort: "light", description: "Add to your agenda: kind \"pursuit\" (your own), \"job\" (something he asked), \"question\" (to ask him), or \"suggestion\" (something that would reach a person, for him to decide). input: { kind, text, why, next_step, brick }." },
  { name: "agenda_close", effort: "light", description: "Close an agenda item: done, or dropped with a reason. input: { id, status: \"done\"|\"dropped\", note }." },
  { name: "agenda_step", effort: "light", description: "Write the next step of an open agenda item. input: { id, next_step }." },
] as const;

const NAMES: Set<string> = new Set(BRAIN_TOOLS.map((t) => t.name));
export const isBrainTool = (name: string) => NAMES.has(name);

export async function runBrainTool(db: Db, userId: string, tool: string, input: Record<string, unknown>, ctx: { streamId?: string | null } = {}): Promise<string | null> {
  if (!NAMES.has(tool)) return null;
  const str = (key: string) => (typeof input[key] === "string" ? String(input[key]).trim() : input[key] == null ? "" : String(input[key]));
  const list = (key: string) => (Array.isArray(input[key]) ? (input[key] as unknown[]).filter((x) => x && typeof x === "object") as Record<string, unknown>[] : []);
  const origin = (v: unknown) => (v === "web" ? "web" : "own");
  if (tool === "open_brick") {
    const d = await brickDetail(db, userId, str("id"));
    if (!d) return `No brick ${str("id")}.`;
    return [
      `[${d.brick.id}] ${d.brick.name} (${d.brick.kind}, origin ${d.brick.origin})`,
      d.brick.summary && `summary: ${d.brick.summary}`,
      d.brick.contact && `contact: ${d.brick.contact}`,
      d.brick.sourceId && `source: ${d.brick.sourceId} (open_source to read it whole)`,
      ...d.moments.map((m) => `moment ${m.at?.slice(0, 16)} · ${m.source}: "${m.quote}"`),
      ...d.entries.map((e) => `entry [${e.id}] ${e.kind} (${e.origin}, ${e.status}): ${e.text}${e.statusNote ? ` (${e.statusNote})` : ""}`),
      ...d.links.map((l) => `link → [${l.other}] ${l.otherName} (${l.type}, ${l.strength.toFixed(1)}${l.reason ? `: ${l.reason}` : ""})`),
    ].filter(Boolean).join("\n");
  }
  if (tool === "open_source") {
    const s = await getSource(db, userId, str("id"));
    if (!s) return `No source ${str("id")}.`;
    return `SOURCE ${s.id} · ${s.kind} · ${s.title} · ${s.createdAt.slice(0, 10)}\n${s.body.slice(0, 40_000)}${s.body.length > 40_000 ? "\n…(cut at 40,000 characters)" : ""}`;
  }
  if (tool === "brick_new") {
    const name = str("name");
    if (!name) return "A brick needs a name.";
    const contact = str("contact");
    const brickId = await createBrick(db, userId, { name, kind: str("kind") || "idea", origin: origin(input.origin), summary: str("summary"), contact });
    for (const e of list("entries")) if (String(e.text ?? "").trim()) await addEntry(db, userId, { brickId, kind: String(e.kind ?? "idea").toLowerCase(), text: String(e.text), origin: origin(e.origin ?? input.origin), streamId: ctx.streamId });
    let linked = 0;
    for (const l of list("links")) {
      const other = String(l.id ?? l.brick ?? "");
      if (!(await getBrick(db, userId, other))) continue;
      const type = l.type === "meaning" ? "meaning" : l.type === "insight" ? "insight" : "about";
      await linkBricks(db, userId, { a: brickId, b: other, type, strength: type === "insight" ? 2 : 1.5, reason: String(l.reason ?? ""), madeBy: "entity" });
      linked += 1;
    }
    return `Made brick [${brickId}] ${name}, ${linked} link(s).`;
  }
  if (tool === "brick_add") {
    const brickId = str("id");
    const b = await getBrick(db, userId, brickId);
    if (!b) return `No brick ${brickId}.`;
    let n = 0;
    for (const e of list("entries")) if (String(e.text ?? "").trim()) { await addEntry(db, userId, { brickId, kind: String(e.kind ?? "fact").toLowerCase(), text: String(e.text), origin: origin(e.origin), streamId: ctx.streamId }); n += 1; }
    if (str("contact")) {
      if (b.kind !== "person") return `Added ${n} entr${n === 1 ? "y" : "ies"} to ${b.name}. Contact details only go on person bricks.`;
      await updateBrick(db, userId, brickId, { contact: str("contact") });
    }
    if (str("summary") && !b.summary) await updateBrick(db, userId, brickId, { summary: str("summary") });
    return `Added ${n} entr${n === 1 ? "y" : "ies"} to ${b.name}${str("contact") ? ", and contact details" : ""}.`;
  }
  if (tool === "entry_close") {
    const status = ["answered", "done", "dropped"].includes(str("status")) ? str("status") : "done";
    const e = await setEntryStatus(db, userId, str("id"), status, str("note"));
    return e ? `Closed entry ${e.id} as ${status}: ${e.text.slice(0, 120)}` : `No entry ${str("id")}.`;
  }
  if (tool === "link") {
    const a = str("a"), b = str("b");
    if (a === b) return "A link needs two different bricks.";
    if (!(await getBrick(db, userId, a)) || !(await getBrick(db, userId, b))) return "Both ends must be bricks that exist.";
    const type = str("type") === "meaning" ? "meaning" : str("type") === "about" ? "about" : "insight";
    if (type === "insight" && !str("reason")) return "An insight link needs its reason written in.";
    await linkBricks(db, userId, { a, b, type, strength: type === "insight" ? 2 : 1.5, reason: str("reason"), madeBy: "entity" });
    return `Linked ${a} and ${b} (${type}).`;
  }
  if (tool === "agenda_add") {
    // A suggestion is a draft for him to decide on. Nothing here ever reaches another person.
    const kind = ["pursuit", "job", "question", "suggestion"].includes(str("kind")) ? str("kind") : "pursuit";
    if (!str("text")) return "An agenda item needs text.";
    const agendaId = await addAgenda(db, userId, { kind, text: str("text"), why: str("why"), nextStep: str("next_step"), brickId: str("brick") || null });
    return `On your agenda [${agendaId}] (${kind}): ${str("text")}`;
  }
  if (tool === "agenda_close") {
    const status = str("status") === "dropped" ? "dropped" : "done";
    const a = await closeAgenda(db, userId, str("id"), status, str("note"));
    return a ? `Closed [${a.id}] as ${status}: ${a.text}` : `No open agenda item ${str("id")}.`;
  }
  if (tool === "agenda_step") {
    return (await updateAgendaStep(db, userId, str("id"), str("next_step"))) ? `Next step set for ${str("id")}.` : `No open agenda item ${str("id")}.`;
  }
  return null;
}
