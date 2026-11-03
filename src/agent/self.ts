import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import type { Db } from "../db.js";
import { getBudget, getSoul, listNotes, listTasks, logAction, spendSince } from "../repo.js";
import { startOfMonth } from "../time.js";
import { TOOLS } from "./registry.js";

const ROOT = process.cwd();
const MECHANICS = join(ROOT, "src", "agent", "HOW_YOU_WORK.md");
/** What it may read of itself: its design, its code and the page code. Never secrets, data, or dependencies. */
const READABLE = ["DESIGN.md", "README.md", "src", "server", "client/src"];
const HIDDEN = /(^|\/)(\.env|node_modules|data|dist|\.git)(\/|$)/;

export function mechanics(): string {
  try {
    return readFileSync(MECHANICS, "utf8");
  } catch {
    return "(The file that explains how you work is missing. Tell Isaak.)";
  }
}

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(ROOT, path).replace(/\\/g, "/");
    if (HIDDEN.test(rel)) continue;
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(rel);
  }
}

export function ownFiles(): string[] {
  const out: string[] = [];
  for (const entry of READABLE) {
    const path = join(ROOT, entry);
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(entry);
  }
  return out.sort();
}

export function readOwnFile(path: string): string {
  const rel = normalize(path).replace(/\\/g, "/").replace(/^(\.\.\/)+/, "").replace(/^\/+/, "");
  if (HIDDEN.test(rel) || !ownFiles().includes(rel)) return `You cannot read "${path}". Files you can read: call look_at_myself without a file to see the list.`;
  const text = readFileSync(join(ROOT, rel), "utf8");
  return text.length > 60_000 ? `${text.slice(0, 60_000)}\n…(cut at 60,000 characters)` : text;
}

const ago = (iso: string | null | undefined): string => {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
};

/** A compact sense of its own body, generated from what actually exists. Always in view. Facts only. */
export async function bodySense(db: Db, userId: string): Promise<string> {
  const iso = (value: unknown) => (value ? new Date(String(value)).toISOString() : null);
  const [fresh, inner, soul, notes, tasks, events, versions, convos, msgs, budget] = await Promise.all([
    db.query(`SELECT created_at FROM fresh_starts WHERE user_id = $1`, [userId]),
    db.query(`SELECT * FROM inner_state WHERE user_id = $1`, [userId]),
    getSoul(db, userId),
    listNotes(db, userId),
    listTasks(db, userId, "open"),
    db.query(`SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = $1 AND archived_at IS NULL AND ends_at > now()`, [userId]),
    db.query(
      `SELECT kind, COUNT(*) AS n, MAX(created_at) AS last FROM inner_versions WHERE user_id = $1
       AND created_at >= COALESCE((SELECT created_at FROM fresh_starts WHERE user_id = $1), 'epoch') GROUP BY kind`,
      [userId],
    ),
    db.query(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = $1 AND archived_at IS NULL`, [userId]),
    db.query(
      `SELECT m.role, COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = $1 AND c.archived_at IS NULL GROUP BY m.role`,
      [userId],
    ),
    getBudget(db, userId),
  ]);
  const state = inner.rows[0] ?? {};
  const started = iso(fresh.rows[0]?.created_at);
  const count = (role: string) => Number(msgs.rows.find((row) => String(row.role) === role)?.n ?? 0);
  const version = (kind: string) => versions.rows.find((row) => String(row.kind) === kind);
  const sections = [...(soul?.content ?? "").matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]);
  const grown = sections.filter((name) => !["Nature", "Purpose", "Values", "Boundaries"].includes(name));
  let regions = 0;
  try {
    regions = (JSON.parse(String(state.life_map || "[]")) as unknown[]).length;
  } catch {
    regions = 0;
  }
  const live = notes.filter((note) => note.status !== "archived");
  const spent = (await spendSince(db, userId, startOfMonth("Europe/Amsterdam").toISOString())).spentEurCents;
  const portrait = version("portrait");
  const intentions = version("intentions");
  return [
    `- Age: started fresh ${started ? `${ago(started)} (${started.slice(0, 16)}Z)` : "at an unknown time"}. ${Number(convos.rows[0]?.n ?? 0)} conversation(s); ${count("user")} message(s) from him, ${count("assistant")} from you.`,
    `- How you work: explained in your own design notes, which you can read with look_at_myself. Last looked: ${ago(iso(state.self_looked_at))}.`,
    `- Soul: ${sections.join(", ") || "(empty)"}${grown.length ? "" : "; nothing has grown beyond the seed yet"}.`,
    `- Understanding of him: portrait ${portrait ? `version ${portrait.n}, last rewritten ${ago(iso(portrait.last))}` : "not written yet"}; map ${regions ? `with ${regions} regions` : "not drawn yet"}; intentions ${intentions ? `version ${intentions.n}, last changed ${ago(iso(intentions.last))}` : "none yet"}.`,
    `- Memory: ${live.length} note(s), ${tasks.length} open ledger item(s), ${Number(events.rows[0]?.n ?? 0)} upcoming calendar item(s).`,
    `- Senses: you perceive his messages and the files he attaches, and the web when you search. Not yet: his email, a calendar outside this app, anything while the server sleeps.`,
    `- Hands: ${TOOLS.length} tools (${TOOLS.map((tool) => tool.name).join(", ")}).`,
    `- How he sees you: Chat (your replies; his words underlined where you kept something), How it sees you (portrait, map, intentions, history), Library (notes), Calendar, Notebook (soul, ledger, debates, change history, tools), Health (cost).`,
    `- Rhythm: ${state.next_wake_at ? `you asked to wake ${new Date(String(state.next_wake_at)).toISOString().slice(0, 16)}Z: ${state.wake_why}` : "no wake-up set"}. Budget: EUR ${(spent / 100).toFixed(2)} of EUR ${(budget.monthlyCapEurCents / 100).toFixed(2)} used this month.`,
  ].join("\n");
}

/** The full look at itself: how it works, every part in detail, its recent history, and (on request) any file of its own design or code. */
export async function lookAtMyself(db: Db, userId: string, input: { file?: string }): Promise<string> {
  await db.query(
    `INSERT INTO inner_state (user_id, self_looked_at) VALUES ($1, now()) ON CONFLICT (user_id) DO UPDATE SET self_looked_at = now()`,
    [userId],
  );
  if (input.file) {
    await logAction(db, userId, { what: "read its own file", why: input.file, source: "agent", payload: {} });
    return `FILE ${input.file}:\n${readOwnFile(input.file)}`;
  }
  await logAction(db, userId, { what: "looked at itself", why: "It took stock of how it works.", source: "agent", payload: {} });
  const soul = await getSoul(db, userId);
  const history = await db.query(
    // Only since the last fresh start: what came before is his history, not its memory.
    `SELECT kind, at, text FROM (
       SELECT 'took in' AS kind, created_at AS at, result AS text FROM thinking_sessions WHERE user_id = $1 AND tool IS NULL
       UNION ALL
       SELECT CASE WHEN m.role = 'user' THEN 'he said' ELSE 'you said' END, m.created_at, m.content
         FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = $1 AND c.archived_at IS NULL
       UNION ALL
       SELECT 'intentions', created_at, content FROM inner_versions WHERE user_id = $1 AND kind = 'intentions'
     ) h WHERE at >= COALESCE((SELECT created_at FROM fresh_starts WHERE user_id = $1), 'epoch') ORDER BY at DESC LIMIT 24`,
    [userId],
  );
  const recent = history.rows
    .reverse()
    .map((row) => `[${new Date(String(row.at)).toISOString().slice(0, 16)}Z] ${row.kind}: ${String(row.text).slice(0, 1500)}`)
    .join("\n\n");
  return [
    `HOW YOU WORK:\n${mechanics()}`,
    `YOUR BODY NOW:\n${await bodySense(db, userId)}`,
    `YOUR SOUL IN FULL:\n${soul?.content ?? "(none)"}`,
    `YOUR TOOLS IN FULL:\n${TOOLS.map((tool) => `${tool.name}: ${tool.description}`).join("\n")}`,
    `YOUR RECENT HISTORY (what you took in, what you intended, what was said, oldest first):\n${recent || "(nothing yet)"}`,
    `FILES OF YOUR OWN DESIGN AND CODE YOU CAN READ (look_at_myself with { file }):\n${ownFiles().join("\n")}`,
  ].join("\n\n");
}
