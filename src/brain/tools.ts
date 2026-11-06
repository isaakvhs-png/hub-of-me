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
  { name: "merge_bricks", effort: "light", description: "Merge two bricks that are the same thing: everything on merge (moments, entries, links) moves to keep, and merge is archived (never deleted). input: { keep, merge, why }." },
  { name: "split_brick", effort: "light", description: "Split a brick that holds two things (two people with one name, say): a new brick gets the entries, moments and links you name, moved off the old one. input: { id, name, kind, summary, entries: [entry ids], moments: [words from the quotes to move], links: [ids of the bricks whose links move], why }." },
  { name: "relabel_link", effort: "light", description: "Change an existing link between two bricks: its type and/or its reason (mark it a guess, correct it). input: { a, b, type?: \"about\"|\"meaning\"|\"insight\"|\"together\", reason, why }." },
  { name: "library", effort: "light", description: "The old Library: notes written before the brick web (research write-ups, a handover, documents). input: { action: \"list\" } or { action: \"read\", id }." },
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
  if (tool === "merge_bricks") {
    const keep = str("keep"), merge = str("merge");
    const k = await getBrick(db, userId, keep), m = await getBrick(db, userId, merge);
    if (!k || !m || keep === merge) return "merge_bricks needs two different bricks that exist (keep and merge).";
    await db.query(`UPDATE brick_moments SET brick_id = $3 WHERE user_id = $1 AND brick_id = $2 AND archived_at IS NULL`, [userId, merge, keep]);
    await db.query(`UPDATE brick_entries SET brick_id = $3 WHERE user_id = $1 AND brick_id = $2 AND archived_at IS NULL`, [userId, merge, keep]);
    const links = (await db.query(`SELECT * FROM brick_links WHERE user_id = $1 AND archived_at IS NULL AND (a = $2 OR b = $2)`, [userId, merge])).rows;
    for (const l of links) {
      const other = String(l.a) === merge ? String(l.b) : String(l.a);
      if (other !== keep) await linkBricks(db, userId, { a: keep, b: other, type: String(l.type), strength: Number(l.strength), reason: String(l.reason ?? ""), madeBy: String(l.made_by ?? "code") });
      await db.query(`UPDATE brick_links SET archived_at = now() WHERE id = $1`, [l.id]);
    }
    await db.query(`UPDATE bricks SET archived_at = now() WHERE id = $1 AND user_id = $2`, [merge, userId]);
    await addEntry(db, userId, { brickId: keep, kind: "fact", text: `Merged in "${m.name}" [${merge}]${str("why") ? `: ${str("why")}` : ""}.`, origin: "own" });
    return `Merged ${m.name} into ${k.name}: ${links.length} link(s) moved; ${m.name} archived.`;
  }
  if (tool === "split_brick") {
    const from = await getBrick(db, userId, str("id"));
    if (!from) return `No brick ${str("id")}.`;
    if (!str("name")) return "split_brick needs a name for the new brick.";
    const ids = (key: string) => (Array.isArray(input[key]) ? (input[key] as unknown[]).map(String).filter(Boolean) : []);
    const brickId = await createBrick(db, userId, { name: str("name"), kind: str("kind") || from.kind, origin: from.origin, summary: str("summary") });
    let entries = 0, moments = 0, links = 0;
    for (const e of ids("entries")) entries += (await db.query(`UPDATE brick_entries SET brick_id = $3 WHERE user_id = $1 AND id = $2 AND brick_id = $4 AND archived_at IS NULL RETURNING id`, [userId, e, brickId, from.id])).rows.length;
    for (const words of ids("moments")) moments += (await db.query(`UPDATE brick_moments SET brick_id = $3 WHERE user_id = $1 AND brick_id = $4 AND archived_at IS NULL AND quote ILIKE $2 RETURNING id`, [userId, `%${words}%`, brickId, from.id])).rows.length;
    for (const other of ids("links")) {
      const [a, b] = [from.id, other].sort();
      const l = (await db.query(`SELECT * FROM brick_links WHERE user_id = $1 AND a = $2 AND b = $3 AND archived_at IS NULL`, [userId, a, b])).rows[0];
      if (!l) continue;
      await linkBricks(db, userId, { a: brickId, b: other, type: String(l.type), strength: Number(l.strength), reason: String(l.reason ?? ""), madeBy: String(l.made_by ?? "code") });
      await db.query(`UPDATE brick_links SET archived_at = now() WHERE id = $1`, [l.id]);
      links += 1;
    }
    await linkBricks(db, userId, { a: from.id, b: brickId, type: "meaning", strength: 1, reason: `split from it${str("why") ? `: ${str("why")}` : ""}`, madeBy: "entity" });
    return `Split [${brickId}] ${str("name")} off ${from.name}: ${entries} entries, ${moments} moments, ${links} links moved.`;
  }
  if (tool === "relabel_link") {
    const [a, b] = [str("a"), str("b")].sort();
    const l = (await db.query(`SELECT * FROM brick_links WHERE user_id = $1 AND a = $2 AND b = $3 AND archived_at IS NULL`, [userId, a, b])).rows[0];
    if (!l) return "There is no link between those two bricks.";
    const type = ["about", "meaning", "insight", "together"].includes(str("type")) ? str("type") : String(l.type);
    const reason = str("reason") || String(l.reason ?? "");
    await db.query(`UPDATE brick_links SET type = $2, reason = $3, updated_at = now() WHERE id = $1`, [l.id, type, reason.slice(0, 600)]);
    return `Link ${a}–${b} is now ${type}${reason ? `: ${reason.slice(0, 120)}` : ""}.`;
  }
  if (tool === "library") {
    if (str("action") === "read") {
      const note = (await db.query(`SELECT * FROM notes WHERE user_id = $1 AND id = $2`, [userId, str("id")])).rows[0];
      if (!note) return `No note ${str("id")}.`;
      return `NOTE [${note.id}] ${note.title} (${note.type}${note.status === "archived" ? ", archived" : ""})\n${String(note.body).slice(0, 40_000)}`;
    }
    const notes = (await db.query(`SELECT id, title, type, status, summary, updated_at FROM notes WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200`, [userId])).rows;
    return notes.map((n) => `[${n.id}] ${n.title} (${n.type}${n.status === "archived" ? ", archived" : ""}, ${new Date(String(n.updated_at)).toISOString().slice(0, 10)})${n.summary ? `: ${String(n.summary).slice(0, 120)}` : ""}`).join("\n") || "The Library is empty.";
  }
  if (tool === "agenda_step") {
    return (await updateAgendaStep(db, userId, str("id"), str("next_step"))) ? `Next step set for ${str("id")}.` : `No open agenda item ${str("id")}.`;
  }
  return null;
}
