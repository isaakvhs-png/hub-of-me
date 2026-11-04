import type { Db } from "../db.js";
import { brickDetail, listAgenda, listBricks, listEntries, listLinks, type AgendaItem } from "./store.js";

/** What the model is shown of the web: its agenda, the whole wall out of focus, and the lit bricks in full. */

const WALL_FULL_CHARS = 70_000;

function ago(at: string | null): string {
  if (!at) return "never";
  const h = (Date.now() - new Date(at).getTime()) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function agendaText(items: AgendaItem[]): string {
  const open = items.filter((a) => a.status === "open");
  const closed = items.filter((a) => a.status !== "open").slice(-5);
  const kind = (k: string) => (k === "job" ? "HIS JOB" : k === "pursuit" ? "YOUR PURSUIT" : k === "question" ? "QUESTION FOR HIM" : k === "suggestion" ? "SUGGESTION FOR HIM" : k.toUpperCase());
  const lines = open.map((a) => `[${a.id}] ${kind(a.kind)}: ${a.text}${a.why ? ` (why: ${a.why})` : ""}${a.nextStep ? ` | next step: ${a.nextStep}` : ""} | open since ${ago(a.createdAt)}`);
  const done = closed.map((a) => `[${a.id}] ${a.status}: ${a.text}${a.closeNote ? ` (${a.closeNote})` : ""}`);
  return `YOUR AGENDA. These are commitments: your own pursuits and his jobs. Act on them, or drop one and say why. Each work session must close something or say why it couldn't.\n${lines.join("\n") || "(empty)"}${done.length ? `\nRecently closed:\n${done.join("\n")}` : ""}`;
}

/** Every brick as one line: the whole wall, so nothing is out of sight even when it is out of focus. */
export async function wallText(db: Db, userId: string): Promise<string> {
  const [bricks, links, entries] = await Promise.all([listBricks(db, userId), listLinks(db, userId), listEntries(db, userId)]);
  if (!bricks.length) return "THE WALL: (empty: nothing has come in yet)";
  const degree = new Map<string, number>();
  for (const l of links) { degree.set(l.a, (degree.get(l.a) ?? 0) + 1); degree.set(l.b, (degree.get(l.b) ?? 0) + 1); }
  const latest = new Map<string, string>();
  for (const e of entries) latest.set(e.brickId, `${e.kind}${e.origin === "own" ? " (yours)" : ""}: ${e.text}`);
  const open = new Map<string, number>();
  for (const e of entries) if (e.status === "open") open.set(e.brickId, (open.get(e.brickId) ?? 0) + 1);
  const lines = bricks.map((b) => {
    const tag = `${b.kind}${b.origin === "own" ? ", your thought" : b.origin === "web" ? ", from the web" : ""}`;
    const bits = [b.summary || latest.get(b.id) || ""].filter(Boolean).join(" ").slice(0, 160);
    const extra = [`${degree.get(b.id) ?? 0} links`, open.get(b.id) ? `${open.get(b.id)} open` : "", b.warmth > 0.1 ? `warm ${b.warmth.toFixed(1)}` : "", `lit ${ago(b.lastLitAt)}`].filter(Boolean).join(", ");
    return `[${b.id}] ${b.name} (${tag}) ${bits} {${extra}}`;
  });
  let text = lines.join("\n");
  if (text.length > WALL_FULL_CHARS) text = bricks.map((b) => `[${b.id}] ${b.name} {${degree.get(b.id) ?? 0} links}`).join("\n");
  return `THE WALL: every brick, one line each (${bricks.length} bricks, ${links.length} links). Out of focus, but in view.\n${text}`;
}

/** The lit bricks in full: summary, contact, every moment with his words, every entry, every link with its reason. */
export async function focusText(db: Db, userId: string, ids: string[], energies?: Map<string, number>): Promise<string> {
  if (!ids.length) return "IN FOCUS: (nothing lit up)";
  const parts: string[] = [];
  for (const brickId of ids) {
    const d = await brickDetail(db, userId, brickId);
    if (!d) continue;
    const e = energies?.get(brickId);
    parts.push(
      [
        `[${d.brick.id}] ${d.brick.name} (${d.brick.kind}, ${d.brick.origin === "own" ? "your thought" : d.brick.origin === "web" ? "from the web" : "from him"})${e != null ? ` energy ${e.toFixed(2)}` : ""}`,
        d.brick.summary ? `summary: ${d.brick.summary}` : "",
        d.brick.contact ? `contact: ${d.brick.contact}` : "",
        ...d.moments.slice(-6).map((m) => `moment ${m.at?.slice(0, 10)} · ${m.source}: "${m.quote}"`),
        ...d.entries.slice(-10).map((x) => `entry [${x.id}] ${x.kind} (${x.origin === "own" ? "yours" : x.origin === "web" ? "web" : "his"}, ${x.status}): ${x.text}${x.statusNote ? ` (${x.statusNote})` : ""}`),
        ...d.links.slice(0, 8).map((l) => `link → [${l.other}] ${l.otherName} (${l.type}, strength ${l.strength.toFixed(1)}${l.reason ? `: ${l.reason}` : ""})`),
      ].filter(Boolean).join("\n"),
    );
  }
  return `IN FOCUS: the bricks this lit up, in full.\n\n${parts.join("\n\n")}`;
}

export async function brainView(db: Db, userId: string, focus: { ids: string[]; energies?: Map<string, number> }): Promise<{ agenda: string; wall: string; focus: string }> {
  const [agenda, wall, f] = await Promise.all([listAgenda(db, userId), wallText(db, userId), focusText(db, userId, focus.ids, focus.energies)]);
  return { agenda: agendaText(agenda), wall, focus: f };
}
