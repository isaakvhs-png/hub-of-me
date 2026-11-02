import { z } from "zod";
import type { Db } from "../db.js";
import type { Router } from "../ai/router.js";
import { routeEffort } from "../ai/effort.js";
import { completeJson, completeText } from "../ai/tracked.js";
import { id } from "../ids.js";
import { textFromUpload } from "../ingest.js";
import { runReflection } from "../pipeline/debate.js";
import { runResearch } from "../pipeline/jobs.js";
import { latestMindNote, listClaims, recordReaction, type TraceEvent } from "../picture.js";
import {
  addMessage,
  createConversation,
  ensureFolderPath,
  getConversation,
  getSettings,
  getSoul,
  insertInfoRequest,
  insertNote,
  listActions,
  listNotes,
  listSoulVersions,
  listTasks,
  logAction,
  setTaskStatus,
} from "../repo.js";
import { ruleListHint } from "../soul.js";
import { closeDeliveredTasks, rememberTasks } from "../tasks.js";
import type { Task } from "../repo.js";
import { locateSpans } from "../trace.js";
import type { Note } from "../types.js";
import { TOOLS, toolSpec } from "./registry.js";
import { getBudget, spendSince } from "../repo.js";
import { startOfMonth } from "../time.js";

const stepSchema = z.object({
  say: z.string().optional(),
  think: z
    .object({
      what: z.string().min(1),
      why: z.string().min(1),
      tool: z.string().min(1),
      input: z.record(z.any()).optional(),
    })
    .optional(),
  state: z
    .object({
      thinking: z.string().optional(),
      curious: z.string().optional(),
      busy: z.string().optional(),
      waiting: z.string().optional(),
    })
    .optional(),
  mind: z.string().optional(),
  topics: z.array(z.object({ label: z.string().min(1), phrase: z.string().min(1) })).optional(),
});

export interface PendingFile {
  name: string;
  bytes: Buffer;
}

export interface TurnResult {
  conversationId: string;
  reply: string;
  userMessageId: string | null;
  notes: Note[];
  closed: Task[];
  filingError: string | null;
  reflection: null;
  traces: TraceEvent[];
}

type TurnEvent = { type: string; [key: string]: unknown };

function prompt(input: { soul: string; notebook: string; cue: string; dump: string; files: string; log: string; name: string; budget: string }): string {
  const tools = TOOLS.map((tool) => `${tool.name}: ${tool.description}`).join("\n");
  return `TASK: agent
You are his partner. His name is ${input.name}. The soul below is your purpose, values, and boundaries. Curiosity stays on. You decide whether to think, what about, and which tool. A tool runs only when you name it.
Do not invent past thinking. If he asks what you did or why, read your records first.
Character grows by reflection on real moments. Do not turn a correction into a new rule.
Return one JSON object: {"say":"","think":{"what":"","why":"","tool":"","input":{}},"state":{"thinking":"","curious":"","busy":"","waiting":""},"mind":"","topics":[{"label":"","phrase":""}]}
say is what he should read, in your own words. think is one tool. phrase values must be copied from his message. If you have nothing to say on a check-in, return {"say":""}.

BUDGET: ${input.budget}

TOOLS:
${tools}

SOUL:
${input.soul}

NOTEBOOK:
${input.notebook}

${input.cue}

DUMP:
${input.dump || "(nothing new)"}
END DUMP

ATTACHMENTS:
${input.files || "(none)"}
END ATTACHMENTS

TOOL RESULTS:
${input.log || "(none)"}
END TOOL RESULTS`;
}

async function notebookBrief(db: Db, userId: string): Promise<string> {
  const soul = await getSoul(db, userId);
  const notes = (await listNotes(db, userId)).filter((note) => note.status !== "archived").slice(0, 8);
  const claims = (await listClaims(db, userId)).slice(0, 6);
  const tasks = (await listTasks(db, userId, "open")).slice(0, 6);
  const mind = await latestMindNote(db, userId);
  const hint = soul ? ruleListHint(soul.content) : null;
  return [
    hint ?? "",
    `Soul:\n${soul?.content ?? "(none)"}`,
    `Notes:\n${notes.map((note) => `${note.title}: ${note.body.slice(0, 160)}`).join("\n") || "(none)"}`,
    `Picture:\n${claims.map((claim) => `${claim.status}: ${claim.statement}`).join("\n") || "(none)"}`,
    `Open to-dos:\n${tasks.map((task) => `${task.id} ${task.title}`).join("\n") || "(none)"}`,
    `Mind: ${mind?.content ?? "(none)"}`,
  ].filter(Boolean).join("\n\n");
}

async function saveState(db: Db, userId: string, state: { thinking?: string; curious?: string; busy?: string; waiting?: string }): Promise<void> {
  await db.query(
    `INSERT INTO inner_state (user_id, thinking, curious, busy, waiting) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id) DO UPDATE SET thinking = COALESCE(NULLIF($2, ''), inner_state.thinking), curious = COALESCE(NULLIF($3, ''), inner_state.curious), busy = COALESCE(NULLIF($4, ''), inner_state.busy), waiting = COALESCE(NULLIF($5, ''), inner_state.waiting), updated_at = now()`,
    [userId, state.thinking ?? "", state.curious ?? "", state.busy ?? "", state.waiting ?? ""],
  );
}

async function rememberSession(db: Db, userId: string, what: string, why: string, tool: string | null, result: string): Promise<void> {
  await db.query(`INSERT INTO thinking_sessions (id, user_id, what, why, tool, result) VALUES ($1,$2,$3,$4,$5,$6)`, [
    id(),
    userId,
    what,
    why,
    tool,
    result.slice(0, 2000),
  ]);
  await logAction(db, userId, { what: tool ? `thought: ${tool}` : "thought", why, source: "agent", payload: { tool, about: what } });
}

export async function runAgentTurn(
  db: Db,
  ai: Router,
  userId: string,
  input: { text?: string; files?: PendingFile[]; conversationId?: string | null; cue?: string; answerMessageId?: string; onEvent?: (event: TurnEvent) => void | Promise<void> },
): Promise<TurnResult> {
  if (input.answerMessageId) {
    // Answer a message he already sent (e.g. after a dropped connection) without saving it twice.
    const held = (await db.query(`SELECT m.content, m.conversation_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1 AND c.user_id = $2`, [input.answerMessageId, userId])).rows[0];
    if (!held) throw new Error("That message is not there.");
    input = { ...input, text: String(held.content), conversationId: String(held.conversation_id) };
  }
  const answering = input.answerMessageId ?? null;
  if (answering) inFlight.add(answering);
  try {
    return await turnBody(db, ai, userId, input, answering);
  } finally {
    if (answering) inFlight.delete(answering);
  }
}

/** Messages being answered right now, so the unanswered-message check never answers one twice. */
const inFlight = new Set<string>();
let liveTurns = 0;

async function turnBody(
  db: Db,
  ai: Router,
  userId: string,
  input: { text?: string; files?: PendingFile[]; conversationId?: string | null; cue?: string; answerMessageId?: string; onEvent?: (event: TurnEvent) => void | Promise<void> },
  answering: string | null,
): Promise<TurnResult> {
  liveTurns += 1;
  try {
    return await turnInner(db, ai, userId, input, answering);
  } finally {
    liveTurns -= 1;
  }
}

async function turnInner(
  db: Db,
  ai: Router,
  userId: string,
  input: { text?: string; files?: PendingFile[]; conversationId?: string | null; cue?: string; answerMessageId?: string; onEvent?: (event: TurnEvent) => void | Promise<void> },
  answering: string | null,
): Promise<TurnResult> {
  const settings = await getSettings(db, userId);
  const who = await db.query(`SELECT name FROM users WHERE id = $1`, [userId]);
  const name = String(who.rows[0]?.name ?? "Isaak");
  const budget = await budgetLine(db, userId);
  const text = input.text?.trim() ?? "";
  const files = input.files ?? [];
  let conversationId = input.conversationId ?? null;
  if (conversationId) {
    const existing = await getConversation(db, userId, conversationId);
    // An archived conversation is notebook history: a new message starts a live one instead of writing into the past.
    if (!existing || existing.archivedAt) conversationId = null;
  }
  const title = text.split("\n")[0] || files[0]?.name || "Hello";
  if (!conversationId && (text || files.length || input.cue === "GREETING DUE")) conversationId = await createConversation(db, userId, title);
  let userMessageId: string | null = null;
  if (answering) userMessageId = answering;
  else if (conversationId && text) userMessageId = await addMessage(db, conversationId, "user", text);
  const notes: Note[] = [];
  const closed: Task[] = [];
  const traces: TraceEvent[] = [];
  let toolLog = "";
  let reply = "";
  let heldSay = "";
  const sourceText = text || files.map((file) => file.name).join("\n");

  // A safety stop on runaway loops, not a limit on its thinking: when it is reached, it is asked to answer with what it has.
  const MAX_STEPS = 8;
  for (let step = 0; step <= MAX_STEPS; step += 1) {
    const last = step === MAX_STEPS;
    const routed = await routeEffort(db, userId, settings, "conversation");
    const soul = await getSoul(db, userId);
    const decision = await completeJson(
      db,
      userId,
      ai,
      {
        role: "conversation",
        model: routed.model,
        effort: "conversation",
        system: prompt({
          soul: soul?.content ?? "",
          notebook: await notebookBrief(db, userId),
          cue: input.cue ?? "",
          dump: text,
          files: files.map((file) => file.name).join("\n"),
          name,
          budget,
          log: last ? `${toolLog}\n(You have thought enough for this turn. Answer him now in say, with what you have; no tool.)` : toolLog,
        }),
        messages: [{ role: "user", content: input.cue === "GREETING DUE" ? "He just arrived." : input.cue === "CHECK IN" ? "You may speak if something is worth saying." : input.cue?.startsWith("WAKE") ? "You woke up on your own. He is away. Think, use tools, or rest; speak only if it is worth his time when he is back." : "Your move." }],
      },
      stepSchema,
      { jobKind: "agent" },
    );
    if (decision.state) await saveState(db, userId, decision.state);
    // It may speak and use a tool in the same step; keep what it said instead of dropping it.
    if (decision.say?.trim()) heldSay = decision.say.trim();
    if (decision.think && !last) {
      const spec = toolSpec(decision.think.tool);
      await input.onEvent?.({ type: "work", status: "running", label: decision.think.what, targetId: null });
      const result = await useTool(db, ai, userId, {
        tool: decision.think.tool,
        input: decision.think.input ?? {},
        text: sourceText,
        conversationId,
        userMessageId,
        files,
        notes,
        closed,
        traces,
        onEvent: input.onEvent,
      });
      if (!conversationId) {
        const created = await db.query(`SELECT id FROM conversations WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId]);
        conversationId = created.rows[0] ? String(created.rows[0].id) : conversationId;
      }
      toolLog += `\n${decision.think.tool}: ${result}`;
      await rememberSession(db, userId, decision.think.what, decision.think.why, decision.think.tool, result);
      await input.onEvent?.({ type: "work", status: "done", label: decision.think.what, targetId: null });
      if (!spec) toolLog += "\n(that tool is not one you have)";
      continue;
    }
    reply = decision.say?.trim() || heldSay;
    if (decision.mind?.trim()) {
      await db.query(`INSERT INTO mind_notes (id, user_id, content) VALUES ($1,$2,$3)`, [id(), userId, decision.mind.trim()]);
      await input.onEvent?.({ type: "mind", label: decision.mind.trim() });
    }
    if (userMessageId && decision.topics?.length) {
      for (const topic of decision.topics) {
        const located = locateSpans(text, [{ phrase: topic.phrase, destination: "topic", label: topic.label }]);
        for (const span of located) {
          const eventId = id();
          await db.query(
            `INSERT INTO trace_events (id, user_id, message_id, start_offset, end_offset, phrase, destination, label, target_id) VALUES ($1,$2,$3,$4,$5,$6,'topic',$7,null)`,
            [eventId, userId, userMessageId, span.start, span.end, span.phrase, topic.label],
          );
          traces.push({ id: eventId, messageId: userMessageId, start: span.start, end: span.end, phrase: span.phrase, destination: "topic", label: topic.label, targetId: null });
        }
      }
    }
    break;
  }

  if (reply) {
    if (!conversationId && input.cue) {
      // Something it says on its own belongs in the conversation he already has, not a new one.
      const live = await db.query(`SELECT id FROM conversations WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId]);
      conversationId = live.rows[0] ? String(live.rows[0].id) : null;
    }
    if (!conversationId) conversationId = await createConversation(db, userId, title);
    await addMessage(db, conversationId, "assistant", reply);
  }
  if (!conversationId) {
    const existing = await db.query(`SELECT id FROM conversations WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId]);
    conversationId = existing.rows[0] ? String(existing.rows[0].id) : await createConversation(db, userId, title);
  }
  return { conversationId, reply, userMessageId, notes, closed, filingError: null, reflection: null, traces };
}

async function useTool(
  db: Db,
  ai: Router,
  userId: string,
  ctx: {
    tool: string;
    input: Record<string, unknown>;
    text: string;
    conversationId: string | null;
    userMessageId: string | null;
    files: PendingFile[];
    notes: Note[];
    closed: Task[];
    traces: TraceEvent[];
    onEvent?: (event: TurnEvent) => void | Promise<void>;
  },
): Promise<string> {
  const settings = await getSettings(db, userId);
  const str = (key: string) => (typeof ctx.input[key] === "string" ? String(ctx.input[key]) : "");
  try {
    if (ctx.tool === "notebook_read") return await notebookBrief(db, userId);
    if (ctx.tool === "read_records") {
      // Its own records start at the last fresh start; what came before is his history, not its memory.
      const marker = (await db.query(`SELECT created_at FROM fresh_starts WHERE user_id = $1`, [userId])).rows[0]?.created_at;
      // A minute of slack: the fresh seed soul is written just before the marker.
      const since = marker ? new Date(String(marker)).getTime() - 60_000 : 0;
      const after = (at: unknown) => !since || new Date(String(at)).getTime() >= since;
      const [allActions, allSessions, allVersions] = await Promise.all([
        listActions(db, userId, 200),
        db.query(`SELECT what, why, tool, created_at FROM thinking_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [userId]),
        listSoulVersions(db, userId),
      ]);
      const actions = allActions.filter((item) => after(item.createdAt)).slice(0, 12);
      const sessions = { rows: allSessions.rows.filter((row) => after(row.created_at)).slice(0, 12) };
      const versions = allVersions.filter((version) => after(version.createdAt));
      const thoughts = sessions.rows.map((row) => `${row.tool ?? "thought"}: ${row.what} — ${row.why}`).join("\n") || "(no thinking sessions)";
      const soul = versions.slice(0, 6).map((version) => `v${version.version} ${version.reason}`).join("\n");
      const log = actions.map((item) => `${item.what} — ${item.why}`).join("\n");
      return `THINKING:\n${thoughts}\n\nACTIONS:\n${log || "(none)"}\n\nSOUL CHANGES:\n${soul || "(none)"}`;
    }
    if (ctx.tool === "notebook_write") {
      const title = str("title") || "Note";
      const body = str("body") || ctx.text || title;
      // Folder and kind are its own choice; "Inbox" and "note" are only what is left when it names none.
      const folder = str("folder").replace(/^\/+|\/+$/g, "") || "Inbox";
      const kind = (str("kind") || str("type")).trim().toLowerCase().slice(0, 40) || "note";
      const saved = await insertNote(db, userId, {
        folderId: await ensureFolderPath(db, userId, folder),
        type: kind,
        title,
        body,
        status: "unexplored",
        forNowExpiresAt: null,
        reason: "He said it, and the entity chose to keep it.",
        causingMessageId: ctx.userMessageId,
        source: "agent",
        mockEra: settings.provider === "mock",
      });
      ctx.notes.push(saved);
      if (str("phrase")) await markPhrase(db, userId, ctx, str("phrase"), "memory", title);
      return `Saved note ${saved.id} in ${folder} as ${kind}: ${title}`;
    }
    if (ctx.tool === "mark") {
      const phrase = str("phrase");
      const destination = str("destination").trim() || "noted";
      const label = str("label") || "Noted";
      const span = await markPhrase(db, userId, ctx, phrase, destination, label);
      return span ? `Marked “${span.phrase}” as ${destination}: ${label}` : "That phrase is not in what he wrote.";
    }
    if (ctx.tool === "todos") {
      const action = str("action") || "list";
      if (action === "remember" && str("title")) {
        const saved = await rememberTasks(db, userId, [{ title: str("title"), why: str("why") || "Worth keeping.", owner: str("owner") === "system" ? "system" : "peter" }], {
          sourceKind: "agent",
          conversationId: ctx.conversationId,
        });
        return `Held quietly: ${saved.map((task) => task.title).join(", ")}`;
      }
      if (action === "fade" && str("taskId")) {
        const faded = await setTaskStatus(db, userId, str("taskId"), "archived", str("reason") || "It no longer belongs in front of him.");
        return faded ? `Faded: ${faded.title}` : "That item was not open.";
      }
      const open = await listTasks(db, userId, "open");
      return open.map((task) => `${task.id} ${task.surfaced ? "now" : "quiet"} ${task.title} — ${task.whyNow || task.why}`).join("\n") || "(ledger empty)";
    }
    if (ctx.tool === "read_file") {
      const name = str("name") || ctx.files[0]?.name || "";
      const file = ctx.files.find((item) => item.name === name) ?? ctx.files[0];
      if (!file) return "No file by that name is attached.";
      return await readOneFile(db, ai, userId, file, ctx);
    }
    if (ctx.tool === "search") {
      const topic = str("topic") || str("query");
      if (!topic) return "A search needs a topic.";
      const found = await runResearch(db, ai, userId, topic);
      return found.blocked ? `Search refused: ${found.reason}` : `Search stored ${found.cardId ?? ""}`.trim();
    }
    if (ctx.tool === "ask") {
      const requestId = await insertInfoRequest(db, userId, {
        subject: str("subject") || "what is still unknown",
        question: str("question") || str("subject") || "What should I understand first?",
        context: str("context") || "This came up while thinking, and the record does not answer it yet.",
        why: str("why") || "It would change what I believe about him.",
        rank: 0,
      });
      if (str("expect")) await recordReaction(db, userId, { subjectKind: "ask", subjectId: requestId, prediction: str("expect") });
      return `Ask held: ${str("question") || str("subject")}`;
    }
    if (ctx.tool === "debate" || ctx.tool === "reflect") {
      const outcome = await runReflection(db, ai, userId, {
        cause: str("cause") || "The entity chose to think this through.",
        conversationId: ctx.conversationId,
        causingMessageId: ctx.userMessageId,
      });
      if ("error" in outcome) return `Reflection stopped: ${outcome.error}`;
      return `Reflection concluded: ${outcome.commitment}`;
    }
    if (ctx.tool === "wake_me") {
      const minutes = Number(ctx.input.in_minutes ?? ctx.input.minutes);
      const why = str("why");
      if (!Number.isFinite(minutes) || minutes <= 0) return "Say in how many minutes you want to wake, as a number.";
      if (!why) return "Say why you want to wake then.";
      const at = new Date(Date.now() + minutes * 60_000).toISOString();
      await db.query(
        `INSERT INTO inner_state (user_id, next_wake_at, wake_why) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET next_wake_at = $2, wake_why = $3, updated_at = now()`,
        [userId, at, why],
      );
      await logAction(db, userId, { what: "set its own wake-up", why, source: "agent", payload: { at } });
      return `You will wake at ${at}: ${why}`;
    }
    if (ctx.tool === "wish") {
      const name = str("name");
      const reason = str("reason");
      if (!name || !reason) return "A wish needs a name and a reason.";
      await db.query(`INSERT INTO tool_wishes (id, user_id, name, reason) VALUES ($1,$2,$3,$4)`, [id(), userId, name, reason]);
      return `Wished for ${name}.`;
    }
    return `No tool named ${ctx.tool}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The tool failed.";
    await logAction(db, userId, { what: "tool failed", why: message, source: "agent", payload: { tool: ctx.tool } });
    return message;
  }
}

async function markPhrase(
  db: Db,
  userId: string,
  ctx: { text: string; userMessageId: string | null; traces: TraceEvent[]; onEvent?: (event: TurnEvent) => void | Promise<void> },
  phrase: string,
  destination: string,
  label: string,
): Promise<TraceEvent | null> {
  const [span] = locateSpans(ctx.text, [{ phrase, destination, label }]);
  if (!span || !ctx.userMessageId) return null;
  const eventId = id();
  let targetId: string | null = null;
  const where = destination.toLowerCase();
  if (/picture/.test(where)) {
    targetId = id();
    await db.query(`INSERT INTO claims (id, user_id, statement, situations, status) VALUES ($1,$2,$3,$4,'tentative')`, [targetId, userId, label, ""]);
    await db.query(`INSERT INTO claim_evidence (id, claim_id, quote, source, source_id) VALUES ($1,$2,$3,'dump',$4)`, [id(), targetId, span.phrase, ctx.userMessageId]);
  }
  if (/ledger|follow/.test(where)) {
    const saved = await rememberTasks(db, userId, [{ title: label, why: "From what he just said.", owner: "peter", surfaced: true, whyNow: label }], {
      sourceKind: "agent",
      sourceId: ctx.userMessageId,
    });
    targetId = saved[0]?.id ?? null;
  }
  await db.query(
    `INSERT INTO trace_events (id, user_id, message_id, start_offset, end_offset, phrase, destination, label, target_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [eventId, userId, ctx.userMessageId, span.start, span.end, span.phrase, destination, label, targetId],
  );
  const event: TraceEvent = { id: eventId, messageId: ctx.userMessageId, start: span.start, end: span.end, phrase: span.phrase, destination, label, targetId };
  ctx.traces.push(event);
  await ctx.onEvent?.({ type: "span", ...event });
  return event;
}

async function readOneFile(db: Db, ai: Router, userId: string, file: PendingFile, ctx: { conversationId: string | null; notes: Note[]; closed: Task[]; text: string }): Promise<string> {
  const settings = await getSettings(db, userId);
  let bodyText = "";
  try {
    const extracted = await textFromUpload(file.name, file.bytes);
    bodyText = extracted.text;
  } catch (error) {
    bodyText = "";
    if (!(error instanceof Error) || !/Use a PDF/.test(error.message)) throw error;
  }
  const visual = /\.(png|jpe?g|webp|gif|pdf)$/i.test(file.name);
  if (!bodyText && visual) {
    const routed = await routeEffort(db, userId, settings, "light");
    const seen = await completeText(
      db,
      userId,
      ai,
      {
        role: "filing",
        model: routed.model,
        effort: "light",
        system: "TASK: vision\nRead this file. Say what is actually in it, in a few sentences. If you cannot read it, say you could not read it.",
        messages: [{ role: "user", content: file.name }],
        images: [{ mediaType: mediaType(file.name), base64: file.bytes.toString("base64") }],
      },
      { jobKind: "vision" },
    );
    bodyText = /could not read/i.test(seen) ? "" : seen.trim();
  }
  if (!bodyText) bodyText = `I could not read ${file.name}.`;
  const note = await insertNote(db, userId, {
    folderId: await ensureFolderPath(db, userId, "Inbox"),
    type: "file",
    title: file.name,
    body: bodyText.slice(0, 8000),
    status: "unexplored",
    forNowExpiresAt: null,
    reason: "Handed over from the chat.",
    causingMessageId: null,
    source: "agent",
    mockEra: settings.provider === "mock",
  });
  ctx.notes.push(note);
  const closed = await closeDeliveredTasks(db, userId, { title: file.name, text: `${ctx.text}\n${bodyText}` }, `Uploaded ${file.name}.`);
  ctx.closed.push(...closed);
  let thread = ctx.conversationId;
  const live = thread ? await getConversation(db, userId, thread) : null;
  if (!thread || !live || live.archivedAt) thread = await createConversation(db, userId, file.name);
  ctx.conversationId = thread;
  await addMessage(db, thread, "user", [`Uploaded ${file.name}`, bodyText].filter(Boolean).join("\n\n").slice(0, 8000));
  const closedLine = closed.length ? ` That closes: ${closed.map((task) => task.title).join("; ")}.` : "";
  await addMessage(db, thread, "assistant", `Filed ${file.name}.${closedLine}`);
  return `READ file: ${file.name}\n${bodyText.slice(0, 500)}`;
}

function mediaType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "image/jpeg";
}

export async function greetIfNeeded(db: Db, ai: Router, userId: string): Promise<void> {
  const fresh = await db.query(`SELECT greeted_at FROM fresh_starts WHERE user_id = $1`, [userId]);
  const row = fresh.rows[0];
  const live = await db.query(`SELECT id FROM conversations WHERE user_id = $1 AND archived_at IS NULL LIMIT 1`, [userId]);
  if ((row && row.greeted_at == null) || (row && !live.rows[0])) {
    await runAgentTurn(db, ai, userId, { cue: "GREETING DUE" });
    await db.query(`UPDATE fresh_starts SET greeted_at = now() WHERE user_id = $1`, [userId]);
    await db.query(
      `INSERT INTO inner_state (user_id, checked_at) VALUES ($1, now()) ON CONFLICT (user_id) DO UPDATE SET checked_at = now()`,
      [userId],
    );
    return;
  }
  const state = await db.query(`SELECT checked_at FROM inner_state WHERE user_id = $1`, [userId]);
  const checked = state.rows[0]?.checked_at;
  const then = checked ? new Date(String(checked)).getTime() : 0;
  if (Number.isFinite(then) && Date.now() - then < 20 * 60 * 60 * 1000) return;
  await runAgentTurn(db, ai, userId, { cue: "CHECK IN" });
  await db.query(
    `INSERT INTO inner_state (user_id, checked_at) VALUES ($1, now()) ON CONFLICT (user_id) DO UPDATE SET checked_at = now()`,
    [userId],
  );
}

async function budgetLine(db: Db, userId: string): Promise<string> {
  const cap = (await getBudget(db, userId)).monthlyCapEurCents;
  const spent = (await spendSince(db, userId, startOfMonth("Europe/Amsterdam").toISOString())).spentEurCents;
  return `This month you have used EUR ${(spent / 100).toFixed(2)} of EUR ${(cap / 100).toFixed(2)}. Thinking while he is away is worth it when it helps him; the budget is yours to spend well.`;
}

/** Fallback alarm: if it set no wake-up, it still gets a chance to look around about once a day. */
const FALLBACK_HOURS = 24;

/** Wake it if the time it chose has come (or the fallback has). Returns true when it woke. */
export async function wakeIfDue(db: Db, ai: Router, userId: string, now = new Date()): Promise<boolean> {
  if (await answerUnanswered(db, ai, userId, now)) return true;
  const row = (await db.query(`SELECT next_wake_at, wake_why, checked_at FROM inner_state WHERE user_id = $1`, [userId])).rows[0];
  const next = row?.next_wake_at ? new Date(String(row.next_wake_at)) : null;
  const checked = row?.checked_at ? new Date(String(row.checked_at)).getTime() : 0;
  let why = "";
  if (next && next.getTime() <= now.getTime()) why = String(row?.wake_why || "You chose to wake now.");
  else if (!next && now.getTime() - checked >= FALLBACK_HOURS * 3_600_000) why = "No wake-up was set, so the fallback alarm woke you. Look around and decide what, if anything, is worth doing.";
  if (!why) return false;
  // Clear it first so a slow or failed run cannot fire twice; it sets a new one itself if it wants.
  await db.query(
    `INSERT INTO inner_state (user_id, next_wake_at, wake_why, checked_at) VALUES ($1, NULL, '', now())
     ON CONFLICT (user_id) DO UPDATE SET next_wake_at = NULL, wake_why = '', checked_at = now()`,
    [userId],
  );
  await logAction(db, userId, { what: "woke up", why, source: "agent", payload: {} });
  await runAgentTurn(db, ai, userId, { cue: `WAKE: ${why}` });
  return true;
}

/**
 * A message of his with no reply after it (a dropped connection, a restart mid-turn) wakes it to answer.
 * Only when no turn is running in this process, the message is over 90 s old (not still being answered) and under a day.
 */
export async function answerUnanswered(db: Db, ai: Router, userId: string, now = new Date()): Promise<boolean> {
  if (liveTurns > 0) return false;
  const last = (
    await db.query(
      `SELECT m.id, m.role, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.user_id = $1 AND c.archived_at IS NULL ORDER BY m.created_at DESC LIMIT 1`,
      [userId],
    )
  ).rows[0];
  if (!last || String(last.role) !== "user") return false;
  const age = now.getTime() - new Date(String(last.created_at)).getTime();
  if (age < 90_000 || age > 24 * 3_600_000 || inFlight.has(String(last.id))) return false;
  // One retry per message, ever: if it chose to say nothing, that stands, and it costs nothing more.
  const tried = await db.query(`SELECT 1 FROM action_log WHERE user_id = $1 AND what = 'answered a message left without reply' AND payload->>'messageId' = $2 LIMIT 1`, [userId, String(last.id)]);
  if (tried.rows[0]) return false;
  await logAction(db, userId, { what: "answered a message left without reply", why: "His message had no answer, likely a dropped connection.", source: "agent", payload: { messageId: String(last.id) } });
  await runAgentTurn(db, ai, userId, { answerMessageId: String(last.id) });
  return true;
}
