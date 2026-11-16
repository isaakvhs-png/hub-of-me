import { id } from "./ids.js";
import { call, callJson, ModelDownError } from "./models.js";
import { bump, db, light, live } from "./state.js";
import { addSource, annotate, applyChanges, lifeAndInstructions, reviseTree, nextLevel, plain, readSummaries, type Change } from "./web.js";
import { addEvent } from "./calendar.js";
import { popup } from "./popups.js";
import { HOW_I_WORK, facts } from "./about.js";
import { createProposal } from "./proposals.js";
import { readUpload } from "./ingest.js";

/**
 * The chat (IDEA.md). It sees his message, "My life", its instructions and recent chat, and reasons: is this enough to
 * answer him? If not, round 2 opens the next level of summaries, and so on until it knows enough. He can click the
 * round number to make it answer with what it has. A separate cheap model checks each round for straying; three
 * such rounds and it stops.
 */

export interface ChatRow { id: string; role: string; text: string; meta: string; created_at: string; source_id: string | null }

export async function history(limit = 200): Promise<ChatRow[]> {
  const r = await db().query<ChatRow>(`SELECT id, role, text, meta, created_at, source_id FROM chat WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT $1`, [limit]);
  return r.rows.reverse();
}

async function saveChat(role: "isaak" | "it", text: string, meta: Record<string, unknown> = {}, sourceId: string | null = null): Promise<string> {
  const chatId = id();
  await db().query(`INSERT INTO chat (id, role, text, source_id, meta) VALUES ($1,$2,$3,$4,$5)`, [chatId, role, text, sourceId, JSON.stringify(meta)]);
  bump();
  return chatId;
}

/**
 * Something it says in the chat without being asked (its own work, a question, an update). Isaak, 15 Nov: what it does
 * on its own comes to him as one paragraph in one message, not as several messages. So while he hasn't written since
 * its last message of its own, a new note is folded into that same message, rewritten as one paragraph.
 */
export async function say(text: string, meta: Record<string, unknown> = {}): Promise<void> {
  const last = (await db().query<ChatRow>(`SELECT * FROM chat WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`)).rows[0];
  const lastMeta = last ? (JSON.parse(last.meta || "{}") as Record<string, unknown>) : {};
  if (last && last.role === "it" && lastMeta.unprompted) {
    let merged = `${last.text} ${text}`;
    try {
      merged = (await call("web", {
        task: "merge-own-work",
        system: "Rewrite these notes about what you did on your own as ONE plain paragraph for Isaak: clear, short, nothing repeated, nothing he can't follow. Keep every question you ask him. Plain text only.",
        prompt: `WHAT YOU ALREADY TOLD HIM:\n${last.text}\n\nNEW:\n${text}`,
        maxTokens: 1500,
      })).text.trim() || merged;
    } catch { /* keep the plain join */ }
    const projects = [...new Set([...(Array.isArray(lastMeta.projectIds) ? lastMeta.projectIds as string[] : lastMeta.projectId ? [String(lastMeta.projectId)] : []), ...(meta.projectId ? [String(meta.projectId)] : [])])];
    await db().query(`UPDATE chat SET text = $2, meta = $3 WHERE id = $1`, [last.id, merged, JSON.stringify({ ...lastMeta, ...meta, unprompted: true, projectIds: projects, projectId: projects[projects.length - 1] ?? null })]);
    if (last.source_id) await db().query(`UPDATE sources SET text = $2 WHERE id = $1`, [last.source_id, merged]);
    bump();
    return;
  }
  const sourceId = await addSource({ kind: "reply", origin: "self", title: "Its own message in the chat", text });
  await saveChat("it", text, { ...meta, unprompted: true }, sourceId);
}

let queue: Promise<void> = Promise.resolve();

/** His message (and files). Stored at once; the answer follows in the background. */
export async function send(text: string, files: { name: string; bytes: Buffer }[] = [], tree = false): Promise<{ chatId: string }> {
  const attachments: { sourceId: string; name: string; readable: boolean; mime: string }[] = [];
  for (const f of files) {
    const read = await readUpload(f.name, f.bytes).catch(() => ({ text: "", readable: false, mime: "application/octet-stream" }));
    const sourceId = await addSource({ kind: "file", origin: "isaak", title: f.name, text: read.text, fileName: f.name, mime: read.mime, bytes: f.bytes, readable: read.readable });
    attachments.push({ sourceId, name: f.name, readable: read.readable, mime: read.mime });
  }
  const sourceId = text.trim() ? await addSource({ kind: "message", origin: "isaak", title: "", text }) : null;
  const chatId = await saveChat("isaak", text, { attachments, ...(tree ? { tree: true } : {}) }, sourceId);
  queue = queue.then(() => (tree ? treeAnswer(chatId, text) : answer(chatId))).catch(() => undefined);
  return { chatId };
}

/** Resolves when every queued answer is written (tests). */
export function chatIdle(): Promise<void> { return queue; }

export function stop() {
  if (live.chat.busy) { live.chat.stopAsked = true; bump(); }
}

const SYSTEM = `You are the chat of Isaak's personal system: you talk with him. Answer like a person who knows him, plainly and briefly; a quick question gets a quick answer.

${HOW_I_WORK}

EACH ROUND you get what you have read so far and the summaries one level further that you could open. Answer with one JSON object:
{"why": "one line: why you open what you open now, or why you answer now",
 "enough": true or false,
 "open": ["ids of summaries (or s:SOURCEID for a source) to read next round"],
 "more_history": 0 (how many earlier chat messages to load next round, if you need them),
 "answer": "your reply to Isaak, when enough is true",
 "actions": []}

ACTIONS you may take with your answer (only when they serve what he said):
- {"do":"create","title":"","under":["summary ids"],"inputs":["s:ID","m:ID"]}, {"do":"move","input":"s:ID|m:ID","from":"id","to":"id"}, {"do":"link","input":"s:ID|m:ID","into":"id"}, {"do":"unlink","input":"s:ID|m:ID","from":"id"}, {"do":"rename","id":"","title":""}, {"do":"merge","ids":["summary ids"],"title":""}, {"do":"absorb","id":""}: manage the web.
- {"do":"calendar","title":"","starts_at":"ISO time with offset","ends_at":"ISO time or empty","all_day":false,"note":""}: add to his calendar; tell him in your answer.
- {"do":"delete_chat","ids":["chat message ids"]}: delete parts of the chat when he asks (they stay in the web).
- {"do":"popup","title":"","body":""}: bring something up as a popup.
- {"do":"proposal","title":"","body":"what and why"}: propose a project of your own.
- {"do":"pack","title":"","prompt":"what the pack should gather"}: make a context pack when he asks for one; it appears in his Context packs folder.`;

async function answer(chatId: string): Promise<void> {
  const msg = (await db().query<ChatRow>(`SELECT * FROM chat WHERE id = $1`, [chatId])).rows[0];
  if (!msg) return;
  live.chat = { busy: true, round: 1, why: "", stopAsked: false };
  bump();
  const meta: { rounds: { why: string; opened: string[]; straying?: boolean }[]; stopped?: string } = { rounds: [] };
  try {
    const { life, instructions } = await lifeAndInstructions();
    light([life.id, ...(instructions ? [instructions.id] : [])]);
    const read: { id: string; title: string; body: string }[] = [];
    const readSources: { id: string; text: string }[] = [];
    let historyCount = 30;
    let strayRun = 0;
    let final = "";
    const attachments = (JSON.parse(msg.meta || "{}").attachments ?? []) as { sourceId: string; name: string; readable: boolean }[];
    for (let round = 1; ; round += 1) {
      live.chat.round = round;
      bump();
      const recent = await recentChat(chatId, historyCount);
      const offered = await nextLevel([life.id, ...read.map((r) => r.id)]);
      const forced = live.chat.stopAsked ? "Isaak clicked to stop: answer NOW with what you have." : strayRun >= 3 ? "You strayed from your core instructions three rounds in a row: stop and answer NOW with what you have, and say that you stopped." : "";
      const prompt = [
        await facts(),
        `MY LIFE (${life.id}):\n${(await annotate(life.body)) || "(still empty: you are just starting)"}`,
        instructions ? `HOW ISAAK WANTS YOU TO WORK (${instructions.id}):\n${(await annotate(instructions.body)) || "(empty)"}` : "",
        read.length ? `SUMMARIES YOU OPENED:\n${read.map((r) => `${r.id} "${r.title}":\n${r.body}`).join("\n\n")}` : "",
        readSources.length ? `SOURCES YOU OPENED:\n${readSources.map((s) => `s:${s.id}:\n${s.text}`).join("\n\n")}` : "",
        `RECENT CHAT (oldest first):\n${recent}`,
        attachments.length ? `HE ATTACHED: ${attachments.map((a) => `${a.name} (s:${a.sourceId}${a.readable ? "" : ", you can't read it yet"})`).join(", ")}` : "",
        `HIS MESSAGE: ${msg.text || "(only attachments)"}`,
        offered.length ? `ONE LEVEL FURTHER YOU COULD OPEN:\n${offered.map((o) => `- ${o.id} | ${o.title} | ${o.gist || "(empty so far)"}`).join("\n")}` : "Nothing further to open.",
        `This is round ${round}.${forced ? `\n${forced}` : ""}`,
      ].filter(Boolean).join("\n\n");
      const out = await callJson<{ why?: string; enough?: boolean; open?: string[]; more_history?: number; answer?: string; actions?: Record<string, unknown>[] }>("chat", { task: "chat", system: SYSTEM, prompt, maxTokens: 6000 });
      live.chat.why = String(out.why ?? "");
      const roundMeta: { why: string; opened: string[]; straying?: boolean } = { why: live.chat.why, opened: [] };
      meta.rounds.push(roundMeta);
      if (out.enough || forced || (!out.open?.length && !out.more_history)) {
        final = String(out.answer ?? "").trim();
        if (!final) final = (await call("chat", { task: "chat-answer", system: SYSTEM.split("EACH ROUND")[0], prompt: `${prompt}\n\nWrite only your reply to Isaak now, as plain text.` })).text.trim();
        if (forced && live.chat.stopAsked) meta.stopped = "Isaak clicked stop";
        else if (forced) meta.stopped = "straying three rounds";
        await doActions(out.actions ?? []);
        break;
      }
      const openIds = (out.open ?? []).map(String);
      const summaryIds = openIds.filter((o) => !o.startsWith("s:") && !read.some((r) => r.id === o));
      const sourceIds = openIds.filter((o) => o.startsWith("s:")).map((o) => o.slice(2));
      for (const r of await readSummaries(summaryIds)) { read.push({ id: r.id, title: r.title, body: await annotate(r.body) }); roundMeta.opened.push(r.id); }
      for (const sid of sourceIds) {
        const row = (await db().query<{ text: string }>(`SELECT left(text, 12000) AS text FROM sources WHERE id = $1`, [sid])).rows[0];
        if (row) { readSources.push({ id: sid, text: row.text }); roundMeta.opened.push(`s:${sid}`); }
      }
      if (out.more_history) historyCount += Math.min(200, Math.max(0, Number(out.more_history)));
      // The runaway check: a separate cheap model.
      const straying = await checkStraying(msg.text, instructions?.body ?? "", live.chat.why);
      roundMeta.straying = straying;
      strayRun = straying ? strayRun + 1 : 0;
    }
    const replySource = await addSource({ kind: "reply", origin: "self", title: "Its reply in the chat", text: final });
    await saveChat("it", final, meta, replySource);
  } catch (error) {
    if (!(error instanceof ModelDownError)) {
      await saveChat("it", `(Something went wrong while answering: ${(error as Error).message})`, { error: true });
    }
  } finally {
    live.chat = { busy: false, round: 0, why: "", stopAsked: false };
    bump();
  }
}

/** The tree button: this message changes how the web is organised; the reply says what changed. */
async function treeAnswer(chatId: string, text: string): Promise<void> {
  live.chat = { busy: true, round: 1, why: "Reorganising the tree", stopAsked: false };
  bump();
  try {
    const out = await reviseTree(text);
    const replySource = await addSource({ kind: "reply", origin: "self", title: "Its reply about the tree", text: out.say });
    await saveChat("it", out.say, { tree: true, touched: out.touched, replyTo: chatId }, replySource);
  } catch (error) {
    if (!(error instanceof ModelDownError)) await saveChat("it", `(Something went wrong while changing the tree: ${(error as Error).message})`, { error: true });
  } finally {
    live.chat = { busy: false, round: 0, why: "", stopAsked: false };
    bump();
  }
}

async function recentChat(beforeId: string, count: number): Promise<string> {
  const r = await db().query<{ id: string; role: string; text: string; created_at: string }>(
    `SELECT id, role, text, created_at FROM chat WHERE deleted_at IS NULL AND created_at <= (SELECT created_at FROM chat WHERE id = $1) AND id <> $1 ORDER BY created_at DESC LIMIT $2`, [beforeId, count]);
  return r.rows.reverse().map((row) => `[${row.id}] ${row.role === "isaak" ? "ISAAK" : "YOU"} (${new Date(row.created_at).toISOString().slice(0, 16)}): ${row.role === "isaak" ? row.text : row.text.slice(0, 3000)}`).join("\n") || "(nothing earlier)";
}

/** The runaway check (Isaak: "a separate cheap model"). True when this round strays from the core instructions without reason. */
export async function checkStraying(question: string, instructions: string, why: string): Promise<boolean> {
  try {
    const out = await callJson<{ straying?: boolean }>("check", {
      task: "runaway-check",
      system: `You watch another model's rounds for runaway loops. It may experiment; it is only straying when it strays from its core instructions without reason and starts wasting resources. Answer with one JSON object: {"straying": true or false}`,
      prompt: `WHAT IT IS WORKING ON: ${question.slice(0, 2000)}\n\nITS CORE INSTRUCTIONS: ${plain(instructions).slice(0, 2000) || "(none yet)"}\n\nITS REASON FOR THIS ROUND: ${why}`,
      maxTokens: 200,
    });
    return Boolean(out.straying);
  } catch {
    return false;
  }
}

async function doActions(actions: Record<string, unknown>[]): Promise<void> {
  const changes: Change[] = [];
  for (const a of actions.slice(0, 30)) {
    const kind = String(a.do ?? "");
    try {
      if (["create", "move", "link", "unlink", "rename", "merge", "absorb"].includes(kind)) changes.push(a as unknown as Change);
      else if (kind === "calendar") {
        await addEvent({ title: String(a.title ?? ""), startsAt: String(a.starts_at ?? ""), endsAt: a.ends_at ? String(a.ends_at) : undefined, allDay: Boolean(a.all_day), note: String(a.note ?? ""), by: "it" });
      } else if (kind === "delete_chat") {
        const ids = (Array.isArray(a.ids) ? a.ids : []).map(String);
        if (ids.length) await db().query(`UPDATE chat SET deleted_at = now() WHERE id = ANY($1)`, [ids]);
      } else if (kind === "popup") {
        await popup("question", String(a.title ?? "A question"), String(a.body ?? ""));
      } else if (kind === "proposal") {
        await createProposal({ title: String(a.title ?? ""), body: String(a.body ?? "") });
      } else if (kind === "pack") {
        const { buildPack } = await import("./packs.js");
        await buildPack(String(a.title ?? ""), String(a.prompt ?? a.title ?? ""));
      }
    } catch { /* one failed action does not stop the others */ }
  }
  if (changes.length) await applyChanges(changes);
  bump();
}

export { doActions };
