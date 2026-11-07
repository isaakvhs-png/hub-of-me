import type { Db } from "../db.js";
import { listFolders, listNotes, listTasks, logAction } from "../repo.js";
import type { Note } from "../types.js";

/**
 * How much full text its memory window holds per step, in characters (about 4 characters per token).
 * Everything it knows is always on the map; this only limits how much of it is open in full at once.
 * While everything fits, everything is open. Past that, it chooses what stays open.
 */
export const MEMORY_BUDGET_CHARS = Number(process.env.MEMORY_BUDGET_CHARS ?? 160_000);
/** Part of the window kept for the conversation itself. */
const CONVERSATION_SHARE = 0.35;

function folderPaths(folders: { id: string; parentId: string | null; name: string }[]): Map<string, string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const paths = new Map<string, string>();
  const pathOf = (id: string, depth = 0): string => {
    const folder = byId.get(id);
    if (!folder || depth > 20) return "";
    const parent = folder.parentId ? pathOf(folder.parentId, depth + 1) : "";
    return parent ? `${parent}/${folder.name}` : folder.name;
  };
  for (const folder of folders) paths.set(folder.id, pathOf(folder.id));
  return paths;
}

export async function openNoteIds(db: Db, userId: string): Promise<string[]> {
  const row = (await db.query(`SELECT open_notes FROM inner_state WHERE user_id = $1`, [userId])).rows[0];
  try {
    const list = JSON.parse(String(row?.open_notes ?? "[]"));
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
}

export async function setOpenNotes(db: Db, userId: string, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  await db.query(
    `INSERT INTO inner_state (user_id, open_notes) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET open_notes = $2`,
    [userId, JSON.stringify(unique)],
  );
}

function fullNote(note: Note, path: string, summary: string): string {
  return `[${note.id}] ${path} · ${note.type} · ${note.title}${summary ? ` — ${summary}` : ""}\n${note.body}`;
}

/** What it has in mind each step: its understanding of him (portrait and map), its intentions, the ledger, the calendar, the map of its notes, and the notes open in full. */
export async function memoryView(db: Db, userId: string): Promise<{ text: string; own: string; conversationChars: number }> {
  const [notes, folders, tasks, summaries, open, asks, events, mapRow] = await Promise.all([
    listNotes(db, userId),
    listFolders(db, userId),
    listTasks(db, userId, "open"),
    db.query(`SELECT id, summary FROM notes WHERE user_id = $1`, [userId]),
    openNoteIds(db, userId),
    db.query(`SELECT subject, question, status FROM info_requests WHERE user_id = $1 AND status = 'open' ORDER BY created_at DESC`, [userId]),
    db.query(
      `SELECT id, title, starts_at, ends_at, why FROM calendar_events WHERE user_id = $1 AND archived_at IS NULL AND ends_at > now() - interval '2 days' AND starts_at < now() + interval '60 days' ORDER BY starts_at`,
      [userId],
    ),
    db.query(`SELECT life_map, portrait, self_portrait, intentions FROM inner_state WHERE user_id = $1`, [userId]),
  ]);
  const live = notes.filter((note) => note.status !== "archived");
  const paths = folderPaths(folders.map((folder) => ({ id: folder.id, parentId: folder.parentId, name: folder.name })));
  const summaryOf = new Map(summaries.rows.map((row) => [String(row.id), String(row.summary ?? "")]));
  const pathOf = (note: Note) => (note.folderId ? paths.get(note.folderId) ?? "" : "") || "(no folder)";

  const inner = mapRow.rows[0] ?? {};
  // What it wrote itself is shown as its own writing, apart from what Isaak and the builders set, so it never reads its old strategy as an instruction.
  const written = (
    await db.query(
      `SELECT kind, MAX(created_at) AS at FROM inner_versions WHERE user_id = $1
       AND created_at >= COALESCE((SELECT created_at FROM fresh_starts WHERE user_id = $1), 'epoch') GROUP BY kind`,
      [userId],
    )
  ).rows;
  const when = (kind: string) => {
    const row = written.find((item) => String(item.kind) === kind);
    return row ? `written by you at ${new Date(String(row.at)).toISOString().slice(0, 16)}Z` : "not written yet";
  };
  const own = [
    `YOUR OWN WRITING. Everything in this part you wrote yourself, at earlier moments. It is yours: keep it, change it, or drop it whenever you see reason. It is not an instruction.`,
    `How you see yourself (your self-portrait, ${when("self_portrait")}): what you are, what you are to him and he to you, how you fit into his life, what you are good at, what you lack, what you want, and what you don't know about yourself:\n${String(inner.self_portrait ?? "").trim() || "(not written yet)"}`,
    `How you think he is (your portrait of him, ${when("portrait")}):\n${String(inner.portrait ?? "").trim() || "(not written yet)"}`,
    `The territory of his life (your map: regions you named yourself, what you know of each, and what you have not seen yet):\n${renderMap(String(inner.life_map ?? ""))}`,
    `What you are going for (your intentions, ${when("intentions")}), and why:\n${String(inner.intentions ?? "").trim() || "(none yet)"}`,
  ].join("\n\n");
  const always = [
    `LEDGER (open):\n${tasks.map((task) => `[${task.id}] ${task.surfaced ? "now" : "quiet"} · ${task.title} — ${task.whyNow || task.why}`).join("\n") || "(empty)"}`,
    `CALENDAR (2 days back to 60 days ahead):\n${events.rows.map((row) => `[${row.id}] ${new Date(String(row.starts_at)).toISOString()} → ${new Date(String(row.ends_at)).toISOString()} · ${row.title}${row.why ? ` — ${row.why}` : ""}`).join("\n") || "(empty)"}`,
    `QUESTIONS YOU ARE HOLDING FOR HIM:\n${asks.rows.map((row) => `${row.subject}: ${row.question}`).join("\n") || "(none)"}`,
    `MAP OF EVERYTHING YOU HAVE WRITTEN (${live.length} notes):\n${live.map((note) => `[${note.id}] ${pathOf(note)} · ${note.type} · ${note.title}${summaryOf.get(note.id) ? ` — ${summaryOf.get(note.id)}` : ""}`).join("\n") || "(empty)"}`,
  ].join("\n\n");

  const notesBudget = Math.max(0, MEMORY_BUDGET_CHARS * (1 - CONVERSATION_SHARE) - always.length - own.length);
  // A file he handed over is kept whole as a source and filed into the web, where it lights up when it is relevant;
  // open_source reads it in full. Carrying every file in full every step would cost the most and add nothing.
  const inMind = live.filter((note) => note.type !== "file");
  const all = inMind.map((note) => fullNote(note, pathOf(note), summaryOf.get(note.id) ?? ""));
  const allChars = all.reduce((sum, text) => sum + text.length + 2, 0);
  let openPart: string;
  if (allChars <= notesBudget) {
    openPart = `OPEN NOTES: everything fits in your memory window, so all ${inMind.length} notes are open in full (files he handed over are in your web as sources; open_source reads one whole).\n\n${all.join("\n\n") || "(none)"}`;
  } else {
    const chosen = inMind.filter((note) => open.includes(note.id));
    const shown: string[] = [];
    let used = 0;
    for (const note of chosen) {
      const text = fullNote(note, pathOf(note), summaryOf.get(note.id) ?? "");
      if (used + text.length > notesBudget) break;
      shown.push(text);
      used += text.length + 2;
    }
    openPart = `OPEN NOTES: your notes no longer all fit in your memory window (about ${Math.round(notesBudget / 1000)}k characters for notes). Everything is still on the map. You chose which to keep open; open or close notes with the open_notes tool. ${shown.length} of ${live.length} open, ${Math.round(used / 1000)}k characters.\n\n${shown.join("\n\n") || "(none open)"}`;
  }
  return { text: `${always}\n\n${openPart}`, own, conversationChars: Math.floor(MEMORY_BUDGET_CHARS * CONVERSATION_SHARE) };
}

/** The live conversation as it remembers it: the newest messages that fit its share of the window, oldest first. */
export async function conversationView(db: Db, userId: string, maxChars: number, skipMessageId?: string | null): Promise<string> {
  const rows = (
    await db.query(
      `SELECT m.id, m.role, m.content, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.user_id = $1 AND c.archived_at IS NULL ORDER BY m.created_at DESC LIMIT 400`,
      [userId],
    )
  ).rows.filter((row) => String(row.id) !== skipMessageId);
  const picked: string[] = [];
  let used = 0;
  // rows run newest first, so rows[i - 1] is the message that came after this one.
  for (const [i, row] of rows.entries()) {
    // A message of his followed by another of his got no answer: a technical failure on our side (a refused or failed
    // call), not him repeating himself. Said plainly, so a resend after an error is not read as a pattern of his.
    const after = i > 0 ? rows[i - 1] : null;
    const unanswered = String(row.role) === "user" && !String(row.content).startsWith("Uploaded ") && after && String(after.role) === "user" ? " [this got no answer: a technical error on your side, not him repeating himself]" : "";
    const line = `${String(row.role) === "user" ? "HIM" : "YOU"} (${new Date(String(row.created_at)).toISOString().slice(0, 16)}): ${String(row.content)}${unanswered}`;
    if (used + line.length > maxChars) {
      picked.push(`(older messages are archived in the notebook history: ${rows.length - picked.length} more)`);
      break;
    }
    picked.push(line);
    used += line.length + 1;
  }
  return picked.reverse().join("\n\n") || "(this is the start of your conversation)";
}

export interface MapRegion {
  name: string;
  known?: string;
  open?: string;
}

export function renderMap(raw: string): string {
  try {
    const regions = JSON.parse(raw || "[]") as MapRegion[];
    if (!Array.isArray(regions) || !regions.length) return "(you have not drawn one yet)";
    return regions.map((region) => `- ${region.name}: known: ${region.known?.trim() || "nothing yet"} | not yet seen: ${region.open?.trim() || "?"}`).join("\n");
  } catch {
    return "(you have not drawn one yet)";
  }
}

/** It redraws its own map; the whole map is replaced, and the old one is kept in the action log. */
export async function saveMap(db: Db, userId: string, regions: MapRegion[], why: string): Promise<number> {
  const clean = regions
    .filter((region) => region && typeof region.name === "string" && region.name.trim())
    .map((region) => ({ name: region.name.trim().slice(0, 80), known: String(region.known ?? "").slice(0, 600), open: String(region.open ?? "").slice(0, 600) }));
  if (!clean.length) return 0;
  const before = (await db.query(`SELECT life_map FROM inner_state WHERE user_id = $1`, [userId])).rows[0]?.life_map ?? "";
  await db.query(
    `INSERT INTO inner_state (user_id, life_map) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET life_map = $2, updated_at = now()`,
    [userId, JSON.stringify(clean)],
  );
  await logAction(db, userId, { what: "redrew its map of his life", why: why || "It learned something.", source: "agent", payload: { before: String(before), after: clean } });
  return clean.length;
}

/** Its portrait of him or its intentions, rewritten whole; every earlier version is kept. */
export async function saveInner(db: Db, userId: string, kind: "portrait" | "self_portrait" | "intentions", content: string, why: string): Promise<boolean> {
  const text = content.trim();
  if (!text) return false;
  const current = (await db.query(`SELECT ${kind} AS value FROM inner_state WHERE user_id = $1`, [userId])).rows[0]?.value;
  if (String(current ?? "").trim() === text) return false;
  await db.query(
    `INSERT INTO inner_state (user_id, ${kind}) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET ${kind} = $2, updated_at = now()`,
    [userId, text],
  );
  await db.query(`INSERT INTO inner_versions (id, user_id, kind, content, why) VALUES ($1,$2,$3,$4,$5)`, [
    `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId,
    kind,
    text,
    why,
  ]);
  if (kind === "intentions") {
    // The chat shows its current state of mind from mind_notes; its intentions are that now.
    await db.query(`INSERT INTO mind_notes (id, user_id, content) VALUES ($1,$2,$3)`, [`mind-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, userId, text]);
  }
  await logAction(db, userId, { what: kind === "portrait" ? "rewrote its portrait of him" : kind === "self_portrait" ? "rewrote its self-portrait" : "updated its intentions", why, source: "agent", payload: {} });
  return true;
}
