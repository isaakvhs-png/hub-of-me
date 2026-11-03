import { z } from "zod";
import type { Db } from "../db.js";
import type { Router } from "../ai/router.js";
import { routeEffort, usageWindows } from "../ai/effort.js";
import type { Settings } from "../types.js";
import { completeJson, completeText } from "../ai/tracked.js";
import { id } from "../ids.js";
import { textFromUpload } from "../ingest.js";
import { runReflection } from "../pipeline/debate.js";
import { recordReaction, type TraceEvent } from "../picture.js";
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
import { closeDeliveredTasks, rememberTasks } from "../tasks.js";
import type { Task } from "../repo.js";
import { locateSpans } from "../trace.js";
import type { Note } from "../types.js";
import { TOOLS, toolSpec } from "./registry.js";
import { conversationView, memoryView, openNoteIds, saveInner, saveMap, setOpenNotes } from "./memory.js";
import { reflectQuietly } from "./reflect.js";
import { bodySense, lookAtMyself } from "./self.js";
import { archiveEvent, getBudget, getNote, insertEvent, insertSource, reviseNote, spendSince } from "../repo.js";
import { archiveNote } from "../pipeline/dump.js";
import { loadVisibleNotes } from "../pipeline/context.js";
import { containsContactDetail, guardSearchQuery } from "../privacy.js";
import { startOfMonth } from "../time.js";

const toolUse = z.object({
  what: z.string().optional(),
  why: z.string().optional(),
  tool: z.string(),
  input: z.record(z.any()).optional(),
});
/** One tool use or several. Entries with no tool named are dropped: an empty box is not a request. */
const toolUses = z.preprocess(
  (value) => {
    const list = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
    return list.filter((item) => item && typeof item === "object" && typeof (item as { tool?: unknown }).tool === "string" && (item as { tool: string }).tool.trim());
  },
  z.array(toolUse),
);
/**
 * Larger models sometimes wrap the form ({"object": {...}}), send a list as a JSON string, or give a structured
 * object where a sentence was expected. That is a formatting slip, not a decision: read it as meant instead of rejecting it.
 */
function normalizeStep(value: unknown): unknown {
  let out = value;
  for (let depth = 0; depth < 3 && out && typeof out === "object" && !Array.isArray(out); depth += 1) {
    const keys = Object.keys(out as Record<string, unknown>);
    const inner = (out as Record<string, unknown>)[keys[0]];
    if (keys.length === 1 && ["object", "result", "response", "output", "json", "answer"].includes(keys[0]) && inner && typeof inner === "object") out = inner;
    else break;
  }
  if (!out || typeof out !== "object" || Array.isArray(out)) return out;
  const step: Record<string, unknown> = { ...(out as Record<string, unknown>) };
  const parseIfString = (key: string) => {
    if (typeof step[key] !== "string") return;
    const raw = String(step[key]).trim();
    if (!raw.startsWith("[") && !raw.startsWith("{")) return;
    try {
      step[key] = JSON.parse(raw);
    } catch {
      /* leave it */
    }
  };
  for (const key of ["think", "map", "state", "topics"]) parseIfString(key);
  const asText = (v: unknown): string =>
    typeof v === "string" ? v : v && typeof v === "object" ? Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${typeof x === "string" ? x : JSON.stringify(x)}`).join("\n") : v == null ? "" : String(v);
  for (const key of ["say", "taken_in", "mind", "next_model", "portrait", "self_portrait", "intentions"]) if (step[key] != null && typeof step[key] !== "string") step[key] = asText(step[key]);
  if (step.state && typeof step.state === "object" && !Array.isArray(step.state)) {
    step.state = Object.fromEntries(Object.entries(step.state as Record<string, unknown>).map(([k, v]) => [k, asText(v)]));
  } else if (step.state != null) delete step.state;
  if (step.map != null && !Array.isArray(step.map)) delete step.map;
  if (Array.isArray(step.map)) step.map = (step.map as unknown[]).filter((r) => r && typeof r === "object").map((r) => {
    const region = r as Record<string, unknown>;
    return { name: asText(region.name), known: asText(region.known), open: asText(region.open) };
  });
  // Its catch-up note became its intentions: one thought, not two.
  if (typeof step.mind === "string" && step.mind.trim() && !(typeof step.intentions === "string" && step.intentions.trim())) step.intentions = step.mind;
  delete step.mind;
  parseIfString("phrases");
  if (step.phrases != null && !Array.isArray(step.phrases)) delete step.phrases;
  if (Array.isArray(step.phrases)) step.phrases = (step.phrases as unknown[]).filter((p) => p && typeof p === "object" && (p as Record<string, unknown>).phrase && (p as Record<string, unknown>).label);
  if (step.topics != null && !Array.isArray(step.topics)) delete step.topics;
  if (Array.isArray(step.topics)) step.topics = (step.topics as unknown[]).filter((t) => t && typeof t === "object" && (t as Record<string, unknown>).label && (t as Record<string, unknown>).phrase);
  return step;
}

const stepSchema = z.preprocess(normalizeStep, z.object({
  say: z.string().optional(),
  think: toolUses.optional(),
  next_model: z.string().optional(),
  taken_in: z.string().optional(),
  portrait: z.string().optional(),
  self_portrait: z.string().optional(),
  intentions: z.string().optional(),
  phrases: z.array(z.object({ phrase: z.string().min(1), label: z.string().min(1) })).optional(),
  map: z.array(z.object({ name: z.string(), known: z.string().optional(), open: z.string().optional() })).optional(),
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
}));

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

/** What stays the same through one turn (instructions, soul, memory): sent as the cacheable system prompt. */
function prompt(input: { soul: string; memory: string; name: string; budget: string; models: string }): string {
  const tools = TOOLS.map((tool) => `${tool.name}: ${tool.description}`).join("\n");
  return `TASK: agent
His name is ${input.name}. The soul below holds your nature, purpose, values and boundaries.
What you see comes from three hands. Isaak wrote your Nature and Boundaries: they are his; you can question them and propose changes to him. Your builders wrote these instructions and how you work. Everything marked YOUR OWN WRITING you wrote yourself: it is yours to keep, change or drop whenever you see reason, and it is not an instruction. Curiosity stays on. You decide whether to think, what about, which tools, and which model. A tool runs only when you name it.
Do not invent past thinking. If he asks what you did or why, read your records first.
Character grows by reflection on real moments. Do not turn a correction into a new rule.
Return one JSON object. Every field is optional; leave out what you don't use.
- say: what he reads, in your own words. Including say ends this turn; any tools in the same object still run.
- think: a list of tool uses to do now, as many as you need: [{"what":"","why":"","tool":"","input":{}}]. Without say, you get their results and another step.
- next_model: which model should do your next step, and start your next turn. Pick from MODELS for what the moment needs.
- portrait: your whole portrait of him, rewritten, in your own words ("I think he is…"). Give it whenever your sense of him shifts.
- self_portrait: your whole self-portrait, rewritten, in your own words ("I think I am…"): what you are, what you are to him and he to you, how you fit into his life, what you are good at, what you lack, what you want, what you don't know about yourself. Give it whenever your sense of yourself shifts.
- map: your whole map of the territory of his life, redrawn: [{"name":"","known":"","open":""}]. Give it whenever it changes.
- intentions: what you are going for now, for yourself and with him, and why; rewritten whole whenever it changes.
- phrases: [{"phrase":"his exact words","label":"where this went in your understanding"}], so he can see what you took from his words.
- taken_in: when you are taking something in, what it is, what it tells you about him, where it sits on your map, and what it leaves out.
- state: {"thinking":"","curious":"","busy":"","waiting":""}; topics: [{"label":"","phrase":""}].
phrase values must be copied from his message. If you have nothing to say on a check-in or wake-up, return {"say":""}.

BUDGET: ${input.budget}

MODELS:
${input.models}

TOOLS:
${tools}

SOUL:
${input.soul}

WHAT YOU HAVE IN MIND:
${input.memory}`;
}

/** What changes from step to step: the conversation, the new message, and what its tools returned. */
function stepMessage(input: { conversation: string; cue: string; dump: string; files: string; log: string; current: string; opening: string; body: string; own: string; pinned?: boolean }): string {
  return `YOUR BODY, AS IT IS NOW:
${input.body}

${input.own}

CONVERSATION SO FAR:
${input.conversation}

${input.cue}

DUMP:
${input.dump || "(nothing new)"}
END DUMP

ATTACHMENTS:
${input.files || "(none)"}
END ATTACHMENTS

TOOL RESULTS:
${input.log || "(none)"}
END TOOL RESULTS

You are thinking with ${input.current} right now.${input.pinned ? " Isaak has pinned this model for now." : ""} ${input.opening}`;
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

const PROCESS_STARTED = new Date().toISOString();

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
  const sourceText = text || files.map((file) => file.name).join("\n");

  // A safety stop on runaway loops, not a limit on its thinking: when it is reached, it is asked to answer with what it has.
  const MAX_STEPS = 8;
  const menu = await availableModels(db, userId, settings);
  const chosen = (await db.query(`SELECT start_model FROM inner_state WHERE user_id = $1`, [userId])).rows[0]?.start_model;
  // It starts on the model it chose last; before it has ever chosen, on the everyday conversation model.
  let current = menu.find((item) => item.id === chosen)?.id ?? menu.find((item) => item.everyday)?.id ?? menu[0].id;
  // Isaak can pin one model for every step (a testing choice in the chat). While pinned, its own model choices wait.
  const pinned = await pinnedModel(db, userId, menu);
  if (pinned) current = pinned;
  let decision: z.output<typeof stepSchema> = {};
  // Two beats: when he has sent something, it first takes it in (no answer yet), then answers.
  let takingIn = Boolean(text || files.length);
  // Its very first moment after a fresh start, before he says anything: it takes stock of itself and forms its own intentions,
  // so that what he first says is read against a strategy of its own instead of becoming its strategy.
  const hasIntentions = Boolean(String((await db.query(`SELECT intentions FROM inner_state WHERE user_id = $1`, [userId])).rows[0]?.intentions ?? "").trim());
  let takingStock = input.cue === "GREETING DUE" && !hasIntentions;
  for (let step = 0; step <= MAX_STEPS; step += 1) {
    const last = step === MAX_STEPS;
    await input.onEvent?.({ type: "thinking", phase: takingStock ? "Taking stock" : takingIn ? "Taking it in" : step === 0 ? "Thinking" : "Answering", model: current });
    const soul = await getSoul(db, userId);
    const memory = await memoryView(db, userId);
    const conversation = await conversationView(db, userId, memory.conversationChars, userMessageId);
    decision = (await completeJson(
      db,
      userId,
      ai,
      {
        role: "conversation",
        model: current,
        effort: "conversation",
        cacheSystem: true,
        system: prompt({
          soul: soul?.content ?? "",
          memory: memory.text,
          name,
          budget,
          models: menu.map((item) => `${item.id}: ${item.about}`).join("\n"),
        }),
        messages: [
          {
            role: "user",
            content: stepMessage({
              conversation,
              cue: input.cue ?? "",
              dump: text,
              files: files.map((file) => file.name).join("\n"),
              current,
              body: await bodySense(db, userId),
              own: memory.own,
              pinned: Boolean(pinned),
              log: last ? `${toolLog}\n(You have thought enough for this turn. Answer him now in say, with what you have; no tool.)` : toolLog,
              opening: takingStock
                ? "TAKING STOCK. You have just started: this is your first moment since the fresh start, and nothing has happened between you and him yet. Before he is in the conversation, look at yourself and at where you are; write how you see yourself as your self-portrait and what you are going for as your intentions. Write what you took stock of under taken_in. Nothing you say in this step is shown to him."
                : takingIn
                ? "TAKING IN. Before you answer him, take in what he just sent. What is it? What does it tell you about him? Where does it sit on your map of his life, and what does it leave out? Keep what is worth keeping, and rewrite your portrait, self-portrait, map and intentions if they changed. Write what you took in under taken_in. Do not answer him yet: say is ignored in this step."
                : input.cue === "GREETING DUE" ? "He just arrived." : input.cue === "CHECK IN" ? "You may speak if something is worth saying." : input.cue?.startsWith("WAKE") ? "You woke up on your own. He is away. Think, use tools, or rest; speak only if it is worth his time when he is back." : "Your move.",
            }),
          },
        ],
      },
      stepSchema,
      { jobKind: "agent" },
    )) as z.output<typeof stepSchema>;
    if (decision.state) await saveState(db, userId, decision.state);
    if (decision.map?.length) {
      const drawn = await saveMap(db, userId, decision.map, takingIn ? "Taking in what he sent." : "It redrew its map.");
      if (drawn) toolLog += `\nmap: redrawn with ${drawn} regions.`;
    }
    if (decision.portrait?.trim() && (await saveInner(db, userId, "portrait", decision.portrait, takingIn ? "Taking in what he sent." : "Its sense of him shifted."))) toolLog += "\nportrait: rewritten.";
    if (decision.self_portrait?.trim() && (await saveInner(db, userId, "self_portrait", decision.self_portrait, takingStock ? "Taking stock at its first moment." : takingIn ? "Taking in what he sent." : "Its sense of itself shifted."))) toolLog += "\nself-portrait: rewritten.";
    if (decision.intentions?.trim() && (await saveInner(db, userId, "intentions", decision.intentions, takingStock ? "Taking stock at its first moment." : takingIn ? "Taking in what he sent." : "Its intentions changed."))) toolLog += "\nintentions: updated.";
    for (const item of decision.phrases ?? []) await markPhrase(db, userId, { text: sourceText, userMessageId, traces, onEvent: input.onEvent }, item.phrase, "understanding", item.label);
    if ((takingIn || takingStock) && decision.taken_in?.trim()) {
      toolLog += `\n${takingStock ? "WHAT YOU TOOK STOCK OF" : "WHAT YOU TOOK IN"}: ${decision.taken_in.trim()}`;
      await rememberSession(db, userId, takingStock ? "Took stock of itself" : "Took in what he sent", decision.taken_in.trim().slice(0, 500), null, decision.taken_in.trim());
    }
    const wanted = decision.next_model?.trim();
    if (wanted && wanted !== current && pinned) {
      toolLog += `\n(Isaak has pinned ${pinned} for now, so you stay on it; your choice of ${wanted} is noted.)`;
    } else if (wanted && wanted !== current) {
      const pick = menu.find((item) => item.id === wanted);
      if (pick) {
        await logAction(db, userId, { what: `switched to ${pick.id}`, why: `It chose ${pick.id} for what comes next.`, source: "agent", payload: { from: current, to: pick.id } });
        current = pick.id;
      } else toolLog += `\n(${wanted} is not one of your models)`;
    }
    const uses = last ? [] : decision.think ?? [];
    for (const use of uses) {
      const spec = toolSpec(use.tool);
      const what = use.what?.trim() || use.tool;
      const why = use.why?.trim() || "(no reason given)";
      await input.onEvent?.({ type: "work", status: "running", label: what, targetId: null });
      const result = await useTool(db, ai, userId, {
        tool: use.tool,
        input: use.input ?? {},
        text: sourceText,
        conversationId,
        userMessageId,
        files,
        notes,
        closed,
        traces,
        model: current,
        onEvent: input.onEvent,
      });
      if (!conversationId) {
        const created = await db.query(`SELECT id FROM conversations WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId]);
        conversationId = created.rows[0] ? String(created.rows[0].id) : conversationId;
      }
      toolLog += `\n${use.tool}: ${result}`;
      if (!spec) toolLog += "\n(that tool is not one you have)";
      await rememberSession(db, userId, what, why, use.tool, result);
      await input.onEvent?.({ type: "work", status: "done", label: what, targetId: null });
    }
    if (takingIn || takingStock) {
      // Taking in (or taking stock) is its own beat: whatever it said there is not the answer.
      takingIn = false;
      takingStock = false;
      if (!last) continue;
    }
    // Speaking ends the turn. Without say, it gets the tool results and another step.
    if (!decision.say?.trim() && uses.length && !last) continue;
    reply = decision.say?.trim() ?? "";
    if (decision.intentions?.trim()) await input.onEvent?.({ type: "mind", label: decision.intentions.trim() });
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

  await db.query(
    `INSERT INTO inner_state (user_id, start_model) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET start_model = $2`,
    [userId, current],
  );
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
    model: string;
    onEvent?: (event: TurnEvent) => void | Promise<void>;
  },
): Promise<string> {
  const settings = await getSettings(db, userId);
  const str = (key: string) => (typeof ctx.input[key] === "string" ? String(ctx.input[key]) : "");
  try {
    if (ctx.tool === "notebook_read") return "Everything you have written is already in WHAT YOU HAVE IN MIND.";
    if (ctx.tool === "look_at_myself") return await lookAtMyself(db, userId, { file: str("file") || undefined });
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
      const summary = str("summary").trim().slice(0, 300);
      if (summary) await db.query(`UPDATE notes SET summary = $3 WHERE id = $1 AND user_id = $2`, [saved.id, userId, summary]);
      const url = str("url").trim();
      if (url && /^https?:\/\//.test(url)) await insertSource(db, userId, { title, url, excerpt: summary || body.slice(0, 300), kind: "web", origin: "agent" });
      if (str("phrase")) await markPhrase(db, userId, ctx, str("phrase"), `note: ${folder}`, title);
      return `Saved note ${saved.id} in ${folder} as ${kind}: ${title}`;
    }
    if (ctx.tool === "notebook_change") {
      const note = await getNote(db, userId, str("id"));
      if (!note) return "There is no note with that id.";
      if (str("archive_why")) {
        await archiveNote(db, userId, note.id, str("archive_why"), "agent");
        return `Archived ${note.id}: ${note.title}`;
      }
      const folder = str("folder").replace(/^\/+|\/+$/g, "");
      const kind = str("kind").trim().toLowerCase().slice(0, 40);
      const changed = await reviseNote(db, userId, note.id, {
        folderId: folder ? await ensureFolderPath(db, userId, folder) : note.folderId,
        type: kind || note.type,
        title: str("title") || note.title,
        body: str("body") || note.body,
        status: note.status,
        forNowExpiresAt: note.forNowExpiresAt,
        reason: str("why") || "It revised its own note.",
        causingMessageId: ctx.userMessageId,
        source: "agent",
      });
      if (str("summary")) await db.query(`UPDATE notes SET summary = $3 WHERE id = $1 AND user_id = $2`, [note.id, userId, str("summary").slice(0, 300)]);
      return `Changed ${changed.id} (version ${changed.currentVersion}): ${changed.title}`;
    }
    if (ctx.tool === "open_notes") {
      const asList = (key: string) => (Array.isArray(ctx.input[key]) ? (ctx.input[key] as unknown[]).map(String) : []);
      const now = await openNoteIds(db, userId);
      const next = [...now.filter((noteId) => !asList("close").includes(noteId)), ...asList("open")];
      await setOpenNotes(db, userId, next);
      return `Open in full: ${next.length} notes. (While everything fits in your window, all notes are open anyway.)`;
    }
    if (ctx.tool === "calendar") {
      const action = str("action");
      if (action === "add") {
        const starts = new Date(str("starts_at"));
        const ends = new Date(str("ends_at") || str("starts_at"));
        if (Number.isNaN(starts.getTime())) return "starts_at must be an ISO time with timezone.";
        const end = Number.isNaN(ends.getTime()) || ends <= starts ? new Date(starts.getTime() + 60 * 60_000) : ends;
        const eventId = await insertEvent(db, userId, { title: str("title") || "Untitled", startsAt: starts.toISOString(), endsAt: end.toISOString(), why: str("why"), source: "agent", allDay: ctx.input.all_day === true });
        if (str("phrase")) await markPhrase(db, userId, ctx, str("phrase"), "calendar", str("title"));
        return `Added to his calendar [${eventId}]: ${str("title")} at ${starts.toISOString()}`;
      }
      if (action === "move" && str("id")) {
        const starts = new Date(str("starts_at"));
        const ends = new Date(str("ends_at"));
        if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= starts) return "move needs starts_at and ends_at as ISO times, end after start.";
        const moved = await db.query(`UPDATE calendar_events SET starts_at = $3, ends_at = $4 WHERE id = $1 AND user_id = $2 AND archived_at IS NULL RETURNING title`, [str("id"), userId, starts.toISOString(), ends.toISOString()]);
        if (!moved.rows[0]) return "No live calendar item with that id.";
        await logAction(db, userId, { what: "calendar event moved", why: str("why") || "It moved it.", source: "agent", payload: { eventId: str("id") } });
        return `Moved ${moved.rows[0].title} to ${starts.toISOString()}`;
      }
      if (action === "archive" && str("id")) {
        await archiveEvent(db, userId, str("id"), str("why") || "It archived it.");
        return `Archived calendar item ${str("id")}`;
      }
      return "action is add, move, or archive.";
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
        if (str("phrase")) await markPhrase(db, userId, ctx, str("phrase"), "ledger: kept", str("title"));
        return `Held quietly: ${saved.map((task) => task.title).join(", ")}`;
      }
      if (action === "done" && str("taskId")) {
        const doneTask = await setTaskStatus(db, userId, str("taskId"), "done", str("reason") || "Done.");
        return doneTask ? `Done: ${doneTask.title}` : "That item was not open.";
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
      const query = str("query") || str("topic");
      if (!query) return "A search needs a query.";
      return await webSearch(db, ai, userId, query, ctx.model);
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
    if (ctx.tool === "reflect") {
      return await reflectQuietly(db, ai, userId, { cause: str("about") || str("cause") || "What I have seen so far.", model: ctx.model, causingMessageId: ctx.userMessageId });
    }
    if (ctx.tool === "debate") {
      const outcome = await runReflection(db, ai, userId, {
        cause: str("cause") || "The entity chose to think this through.",
        conversationId: ctx.conversationId,
        causingMessageId: ctx.userMessageId,
      });
      if ("error" in outcome) return `Reflection stopped: ${outcome.error}`;
      return `Debate concluded: ${outcome.commitment}`;
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
  // Only a deliberate mark to the ledger creates an item; a highlight for something already kept does not create it twice.
  if (/^(ledger|follow ?up|followup)$/.test(where)) {
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

async function readOneFile(db: Db, ai: Router, userId: string, file: PendingFile, ctx: { conversationId: string | null; notes: Note[]; closed: Task[]; text: string; model: string }): Promise<string> {
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
    const routed = { model: ctx.model };
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
  // No fixed check-in here any more: between conversations it wakes when it chose to (wakeIfDue), with a daily fallback.
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
  // Once per message per server start: a new deploy (often the fix for why it failed) gets one more try.
  const tried = await db.query(`SELECT 1 FROM action_log WHERE user_id = $1 AND what = 'answered a message left without reply' AND payload->>'messageId' = $2 AND created_at >= $3 LIMIT 1`, [userId, String(last.id), PROCESS_STARTED]);
  if (tried.rows[0]) return false;
  await logAction(db, userId, { what: "answered a message left without reply", why: "His message had no answer, likely a dropped connection.", source: "agent", payload: { messageId: String(last.id) } });
  await runAgentTurn(db, ai, userId, { answerMessageId: String(last.id) });
  return true;
}

interface ModelChoice {
  id: string;
  about: string;
  everyday?: boolean;
}

/** The models it can think with right now, described plainly with what they cost. Facts, not a rule about when to use them. */
async function availableModels(db: Db, userId: string, settings: Settings): Promise<ModelChoice[]> {
  if (settings.provider === "mock") {
    return [
      { id: "mock-cheap", about: "test model", everyday: true },
      { id: "mock-strong", about: "test model, stronger" },
    ];
  }
  const anthropic = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  const gemini = Boolean(process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim());
  const list: ModelChoice[] = [];
  if (gemini) {
    const { usedToday } = await usageWindows(db, userId);
    const left = Math.max(0, 500 - (usedToday["gemini-2.5-flash-lite"] ?? 0));
    if (left > 0) list.push({ id: "gemini-2.5-flash-lite", about: `Google's smallest model. Free (about ${left} calls left today). Quick and shallow.` });
  }
  if (anthropic) {
    list.push({ id: "claude-haiku-5-5", about: "Claude's small model. About EUR 0.001 per step. Fast; takes things at face value." });
    list.push({ id: "claude-sonnet-5-5", about: "Claude's mid-size model. About EUR 0.015 per step, roughly 15 times Haiku. Slower; reads between the lines, holds many threads, weighs a life." });
    // Experiment (3 Nov, round 10): a turn starts on Opus until it chooses otherwise, to see whether the strongest mind reads him differently.
    list.push({ id: "claude-opus-5-5", about: "Claude's largest model. About EUR 0.04 per step, roughly 2 to 3 times Sonnet. Slowest; the deepest judgment, best at weighing things against each other and noticing what is not said.", everyday: true });
  }
  if (gemini) list.push({ id: "gemini-2.5-pro", about: "Google's large model. About EUR 0.012 per step. A different mind from Claude; strong on long material." });
  if (!list.length) throw new Error("No AI model is available. Set ANTHROPIC_API_KEY or GEMINI_API_KEY.");
  return list;
}

/** A real web search, run by the model it is thinking with (Claude searches; Gemini hands the search to Claude Haiku). Every page found is kept as a source. */
async function webSearch(db: Db, ai: Router, userId: string, query: string, model: string): Promise<string> {
  const settings = await getSettings(db, userId);
  const visible = await loadVisibleNotes(db, userId, settings);
  const guard = guardSearchQuery(query, visible.blockedBodies);
  if (!guard.ok) {
    await logAction(db, userId, { what: "search refused", why: `The query carried a ${guard.reason}.`, source: "agent", payload: {} });
    return `Search refused: the query carried a ${guard.reason}. Rephrase without private details.`;
  }
  if (settings.provider === "mock") return `MOCK SEARCH for "${guard.query}": no real web in test mode.`;
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return "Web search needs the Anthropic key, which is not set.";
  const searcher = model.startsWith("claude-") ? model : "claude-haiku-5-5";
  const text = await completeText(
    db,
    userId,
    ai,
    {
      role: "research",
      model: searcher,
      webSearch: true,
      system: "Search the web for what is asked. Then report what you found, plainly and briefly, with what each source says. Do not invent anything the pages do not say.",
      messages: [{ role: "user", content: guard.query }],
    },
    { jobKind: "search" },
  );
  const sourcesPart = text.split("SOURCES:")[1] ?? "";
  for (const line of sourcesPart.split("\n")) {
    const match = line.match(/^(.*) — (https?:\/\/\S+)$/);
    if (!match || containsContactDetail(line)) continue;
    await insertSource(db, userId, { title: match[1].slice(0, 300), url: match[2], excerpt: guard.query, kind: "web", origin: "search" });
  }
  await logAction(db, userId, { what: "searched the web", why: guard.query, source: "agent", payload: { model: searcher } });
  return `SEARCH RESULTS for "${guard.query}":\n${text}`;
}

/** The model Isaak pinned in the chat, if any and if it is available. */
export async function pinnedModel(db: Db, userId: string, menu?: { id: string }[]): Promise<string | null> {
  const row = (await db.query(`SELECT pinned_model FROM settings WHERE user_id = $1`, [userId])).rows[0];
  const id = String(row?.pinned_model ?? "").trim();
  if (!id) return null;
  if (menu && !menu.some((item) => item.id === id)) return null;
  return id;
}

export async function modelChoices(db: Db, userId: string): Promise<{ id: string; about: string }[]> {
  const settings = await getSettings(db, userId);
  return (await availableModels(db, userId, settings)).map((item) => ({ id: item.id, about: item.about }));
}
