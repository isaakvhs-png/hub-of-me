import { id } from "./ids.js";
import { callJson, callModel, call, modelFolder, roleDown, ROLE_MODEL } from "./models.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { bump, db, lightProject, wake } from "./state.js";
import { addSource, feed, freshen, getSummary, markStale, parentsOf, placeSummary, projectSummary, rewrite } from "./web.js";
import { buildPack, getPack, listPacks, openSources, packText } from "./packs.js";
import { MODULES, cleanBoard, describeBoard, emptyBoard, parseBoard, validateRunnable, type Board, type Piece } from "./board.js";
import { checkStraying } from "./chat.js";

/**
 * Projects = workspace sessions (IDEA.md). A blank board in front of him, Lego pieces in folders at the side. He talks,
 * the workspace AI (Opus) answers and suggests a board change; he accepts or revises; the accepted board is the canon
 * board, with back and forth through its versions. Go runs it. Closing writes a project summary into the web; the
 * reopen button stays for 24 hours, and the summary has "pick this back up".
 */

export interface Project { id: string; title: string; owner: string; status: string; goal: string; proposal_id: string | null; summary_id: string | null; closed_at: string | null; last_active_at: string; created_at: string }

export async function createProject(p: { title: string; owner: "isaak" | "it"; goal?: string; proposalId?: string | null }): Promise<string> {
  const projectId = id();
  await db().query(`INSERT INTO projects (id, title, owner, goal, proposal_id) VALUES ($1,$2,$3,$4,$5)`, [projectId, (p.title.trim() || "A new project").slice(0, 200), p.owner, p.goal ?? "", p.proposalId ?? null]);
  await db().query(`INSERT INTO boards (id, project_id, version, data) VALUES ($1,$2,1,$3)`, [id(), projectId, JSON.stringify(emptyBoard())]);
  lightProject(projectId);
  return projectId;
}

export async function getProject(projectId: string): Promise<Project> {
  const r = await db().query<Project>(`SELECT * FROM projects WHERE id = $1`, [projectId]);
  if (!r.rows[0]) throw new NotFoundError("No such project.");
  return r.rows[0];
}

export async function listProjects() {
  const r = await db().query<Project>(`SELECT * FROM projects ORDER BY last_active_at DESC LIMIT 500`);
  return r.rows;
}

async function touch(projectId: string) {
  await db().query(`UPDATE projects SET last_active_at = now() WHERE id = $1`, [projectId]);
  lightProject(projectId);
}

export async function canon(projectId: string): Promise<{ version: number; board: Board }> {
  const r = await db().query<{ version: number; data: string }>(`SELECT version, data FROM boards WHERE project_id = $1 ORDER BY version DESC LIMIT 1`, [projectId]);
  const row = r.rows[0];
  return { version: Number(row?.version ?? 0), board: parseBoard(row?.data) };
}

async function known() {
  const packs = new Set((await db().query<{ id: string }>(`SELECT id FROM packs`)).rows.map((r) => r.id));
  const folder = await modelFolder();
  const models = new Set([...folder.claude, ...folder.gemini]);
  const runs = new Set((await db().query<{ id: string }>(`SELECT id FROM runs`)).rows.map((r) => r.id));
  return { packs, models, runs };
}

/** A new canon board (he accepted a suggestion, dragged something himself, or went back to an old version). */
export async function setBoard(projectId: string, raw: unknown): Promise<number> {
  await getProject(projectId);
  const board = cleanBoard(raw, await known());
  const { version } = await canon(projectId);
  await db().query(`INSERT INTO boards (id, project_id, version, data) VALUES ($1,$2,$3,$4)`, [id(), projectId, version + 1, JSON.stringify(board)]);
  await touch(projectId);
  return version + 1;
}

export async function boardVersions(projectId: string) {
  const r = await db().query<{ version: number; data: string; created_at: string }>(`SELECT version, data, created_at FROM boards WHERE project_id = $1 ORDER BY version`, [projectId]);
  return r.rows.map((row) => ({ version: Number(row.version), board: parseBoard(row.data), created_at: row.created_at }));
}

export async function projectView(projectId: string) {
  const project = await getProject(projectId);
  const messages = await db().query<{ id: string; role: string; text: string; proposed_board: string | null; created_at: string }>(`SELECT id, role, text, proposed_board, created_at FROM project_messages WHERE project_id = $1 ORDER BY created_at`, [projectId]);
  const runs = await db().query<{ id: string; board_version: number; status: string; log: string; result: string; waiting_piece: string | null; started_at: string; finished_at: string | null }>(`SELECT id, board_version, status, log, result, waiting_piece, started_at, finished_at FROM runs WHERE project_id = $1 ORDER BY started_at`, [projectId]);
  return { project, canon: await canon(projectId), versions: await boardVersions(projectId), messages: messages.rows, runs: runs.rows.map((r) => ({ ...r, log: safeArray(r.log) })) };
}

function safeArray(raw: unknown): unknown[] { try { const v = JSON.parse(String(raw)); return Array.isArray(v) ? v : []; } catch { return []; } }

export async function lego() {
  const folder = await modelFolder();
  return { packs: (await listPacks()).map((p) => ({ id: p.id, title: p.title, prompt: p.prompt })), models: folder, modules: MODULES };
}

const AI_SYSTEM = `You are the workspace AI in Isaak's personal system: you and he co-work on a board in front of him, in rounds.
He talks; you answer briefly and suggest a board change; he accepts or asks for more changes. The board is built from Lego pieces that already exist; you can never make up a piece.

THE PIECES:
- "pack": a context pack (ref = its id). Packs are the only way the board reads his memory web. A pack holds summaries with the raw sources under each (a model can open those when it needs them). A pack piece reads the pack's current version unless it has "version": "snapshot" (the pack as it was gathered); that is Isaak's choice per pack. To make a new one, ask for it in "make_packs" and use ref "new:0", "new:1" … on the board for the packs you asked for.
- "model": a model (ref = its exact name from the models folder). Its "instructions" are its own; the run's instructions (runInstructions) go to every model. If a model has none of its own, the run's instructions are used.
- "module": a module (ref = its name), e.g. "web-search".
- "me": Isaak, the need-input element (id "me"). An arrow from a model to "me" means: give Isaak this; if it is the model's last step that is its final result, otherwise the run pauses there and asks him for input.
- "result": a run's result (ref = run id). Results are placed by the system; leave them where they are.

ARROWS: {"from": piece id, "to": piece id, "step": n}. Arrows from a model carry that model's step numbers: step 1, 2, 3 … is the order it moves in. An arrow from a pack into a model gives the pack to that model (no step). An arrow from a model to another model hands over its output. Everything starts at the same time when he presses Go; converging lines mean wait for both inputs to finish before continuing.
Lay pieces out left to right in the order things happen (x from 80 to 1100, y from 60 to 600), with room between them.

Answer with one JSON object:
{"reply": "what you say to him", "board": the whole new board {"pieces": [...], "arrows": [...], "runInstructions": ""} or null if nothing on the board should change, "make_packs": [{"title": "", "prompt": "what the pack should gather"}], "go": false}
Set "go" to true only when he clearly asks you to run it now.`;

/** He talks in the workspace; the workspace AI answers and suggests a board change. */
export async function talk(projectId: string, text: string, by: "isaak" | "it" = "isaak"): Promise<{ reply: string; proposed: Board | null; go: boolean }> {
  const project = await getProject(projectId);
  if (!text.trim()) throw new ValidationError("Say something.");
  if (project.status === "closed") await reopen(projectId);
  await db().query(`INSERT INTO project_messages (id, project_id, role, text) VALUES ($1,$2,$3,$4)`, [id(), projectId, by === "isaak" ? "isaak" : "it-self", text]);
  await touch(projectId);
  if (by === "isaak" && project.owner === "it" && ["junction", "waiting"].includes(project.status)) {
    // His input on its own project: it may go on.
    await db().query(`UPDATE projects SET status = 'open' WHERE id = $1`, [projectId]);
    wake();
  }
  bump();
  const waiting = await db().query<{ id: string }>(`SELECT id FROM runs WHERE project_id = $1 AND status = 'waiting' ORDER BY started_at DESC LIMIT 1`, [projectId]);
  if (waiting.rows[0] && by === "isaak") {
    // A run is waiting at "me": his words are the input it asked for.
    await giveInput(waiting.rows[0].id, text);
    const reply = "Thanks: the run goes on with that.";
    await db().query(`INSERT INTO project_messages (id, project_id, role, text) VALUES ($1,$2,'ai',$3)`, [id(), projectId, reply]);
    return { reply, proposed: null, go: false };
  }
  return askAi(projectId);
}

async function askAi(projectId: string): Promise<{ reply: string; proposed: Board | null; go: boolean }> {
  const project = await getProject(projectId);
  const { board, version } = await canon(projectId);
  const lg = await lego();
  const msgs = await db().query<{ role: string; text: string }>(`SELECT role, text FROM project_messages WHERE project_id = $1 ORDER BY created_at DESC LIMIT 40`, [projectId]);
  const runs = await db().query<{ id: string; status: string; result: string }>(`SELECT id, status, result FROM runs WHERE project_id = $1 ORDER BY started_at DESC LIMIT 5`, [projectId]);
  const prompt = [
    `PROJECT "${project.title}" (${project.owner === "it" ? "your own project" : "his project"})${project.goal ? `\nGOAL: ${project.goal}` : ""}`,
    `THE CANON BOARD (version ${version}):\n${describeBoard(board)}\nAS JSON: ${JSON.stringify(board)}`,
    `THE LEGO FOLDERS:\nContext packs: ${lg.packs.map((p) => `${p.id} "${p.title}"`).join("; ") || "(none yet)"}\nModels: Claude: ${lg.models.claude.join(", ")}; Gemini: ${lg.models.gemini.join(", ")}\nModules: ${lg.modules.map((m) => `${m.name}: ${m.description}`).join(" | ")}`,
    runs.rows.length ? `LATEST RUNS:\n${runs.rows.map((r) => `${r.id} (${r.status}): ${r.result.slice(0, 1500)}`).join("\n")}` : "",
    `THE CONVERSATION (oldest first):\n${msgs.rows.reverse().map((m) => `${m.role === "isaak" ? "ISAAK" : m.role === "it-self" ? "YOU (working on your own)" : "YOU"}: ${m.text}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");
  const out = await callJson<{ reply?: string; board?: unknown; make_packs?: { title?: string; prompt?: string }[]; go?: boolean }>("work", { task: "workspace", system: AI_SYSTEM, prompt, maxTokens: 8000 });
  const newPacks: string[] = [];
  for (const mp of (out.make_packs ?? []).slice(0, 6)) {
    if (!mp?.prompt?.trim()) continue;
    newPacks.push(await buildPack(String(mp.title ?? ""), mp.prompt));
  }
  let proposed: Board | null = null;
  if (out.board && typeof out.board === "object") {
    const rawBoard = JSON.parse(JSON.stringify(out.board).replace(/"new:(\d+)"/g, (_m, n) => JSON.stringify(newPacks[Number(n)] ?? `missing-${n}`)));
    // A new pack the model forgot to put on the board still goes on it.
    for (const [i, packId] of newPacks.entries()) {
      if (!JSON.stringify(rawBoard).includes(packId)) {
        const pack = await getPack(packId);
        (rawBoard.pieces ??= []).push({ id: `pack-${packId.slice(0, 6)}`, type: "pack", ref: packId, label: pack.title, x: 80, y: 200 + i * 90 });
      }
    }
    proposed = cleanBoard(rawBoard, await known());
  } else if (newPacks.length) {
    const b = JSON.parse(JSON.stringify(board)) as Board;
    for (const [i, packId] of newPacks.entries()) b.pieces.push({ id: `pack-${packId.slice(0, 6)}`, type: "pack", ref: packId, label: (await getPack(packId)).title, x: 80, y: 200 + i * 90 });
    proposed = cleanBoard(b, await known());
  }
  const reply = String(out.reply ?? "").trim() || (proposed ? "Here is a change to the board." : "OK.");
  await db().query(`INSERT INTO project_messages (id, project_id, role, text, proposed_board) VALUES ($1,$2,'ai',$3,$4)`, [id(), projectId, reply, proposed ? JSON.stringify(proposed) : null]);
  await touch(projectId);
  bump();
  return { reply, proposed, go: Boolean(out.go) };
}

/** He accepts the suggested board: it becomes the canon board. */
export async function acceptSuggestion(projectId: string, messageId: string): Promise<number> {
  const r = await db().query<{ proposed_board: string | null }>(`SELECT proposed_board FROM project_messages WHERE id = $1 AND project_id = $2`, [messageId, projectId]);
  if (!r.rows[0]?.proposed_board) throw new NotFoundError("That message has no board suggestion.");
  const version = await setBoard(projectId, JSON.parse(r.rows[0].proposed_board));
  await db().query(`UPDATE project_messages SET proposed_board = NULL WHERE id = $1`, [messageId]);
  await db().query(`INSERT INTO project_messages (id, project_id, role, text) VALUES ($1,$2,'system',$3)`, [id(), projectId, `Board version ${version} accepted.`]);
  return version;
}

// ---------- runs ----------

interface LogEntry { at: string; piece: string; model?: string; step?: number; kind: string; input?: string; thoughts?: string; output?: string; ms?: number; note?: string }

const stopRequested = new Set<string>();
const waiters = new Map<string, (input: string) => void>();

export function stopRun(runId: string) { stopRequested.add(runId); const w = waiters.get(runId); if (w) w("(Isaak stopped the run.)"); }

async function giveInput(runId: string, text: string) {
  const w = waiters.get(runId);
  if (w) w(text);
}

const logs = new Map<string, LogEntry[]>();
const writes = new Map<string, Promise<void>>();

/** Steps run at the same time, so the log is kept in memory and written one write after another. */
async function appendLog(runId: string, entry: LogEntry) {
  if (!logs.has(runId)) {
    const r = await db().query<{ log: string }>(`SELECT log FROM runs WHERE id = $1`, [runId]);
    if (!logs.has(runId)) logs.set(runId, safeArray(r.rows[0]?.log) as LogEntry[]);
  }
  logs.get(runId)!.push(entry);
  const next = (writes.get(runId) ?? Promise.resolve()).then(() => db().query(`UPDATE runs SET log = $2 WHERE id = $1`, [runId, JSON.stringify(logs.get(runId))]).then(() => undefined));
  writes.set(runId, next.catch(() => undefined));
  await next;
  bump();
}

async function flushLog(runId: string) {
  await (writes.get(runId) ?? Promise.resolve());
  logs.delete(runId);
  writes.delete(runId);
}

const STEP_SYSTEM = `You are one model on a board in Isaak's workspace. Do what your instructions ask with what you were given.
If your context packs list raw sources and you judge you need one (to check something against what was actually said or written), answer only with lines OPEN s:ID and you will get them; otherwise answer directly.
Write your answer in two parts:
THOUGHTS: how you go about it (short)
OUTPUT: what you hand on`;

function splitAnswer(text: string): { thoughts: string; output: string } {
  const m = /THOUGHTS:\s*([\s\S]*?)\n\s*OUTPUT:\s*([\s\S]*)$/i.exec(text);
  if (m) return { thoughts: m[1].trim(), output: m[2].trim() };
  return { thoughts: "", output: text.trim() };
}

/** Go: everything starts at once. Each model follows its own numbered arrows; converging lines wait for all their inputs. */
export async function startRun(projectId: string, by: "isaak" | "it" = "isaak"): Promise<string> {
  const project = await getProject(projectId);
  const { board, version } = await canon(projectId);
  validateRunnable(board);
  if (roleDown("work") && project.owner === "it") throw new ValidationError("Projects are shut down: Opus is not available.");
  const runId = id();
  await db().query(`INSERT INTO runs (id, project_id, board_version, status) VALUES ($1,$2,$3,'running')`, [runId, projectId, version]);
  await touch(projectId);
  void execute(runId, projectId, board, by).catch(async (error) => {
    await appendLog(runId, { at: new Date().toISOString(), piece: "-", kind: "error", note: (error as Error).message });
    await db().query(`UPDATE runs SET status = 'failed', finished_at = now(), result = $2 WHERE id = $1`, [runId, `The run failed: ${(error as Error).message}`]);
    bump();
  });
  return runId;
}

/** Runs to the end (tests and its own work wait for this). */
export async function runAndWait(projectId: string, by: "isaak" | "it" = "isaak", timeoutMs = 30 * 60_000): Promise<{ id: string; status: string; result: string }> {
  const runId = await startRun(projectId, by);
  const started = Date.now();
  for (;;) {
    const r = await db().query<{ status: string; result: string }>(`SELECT status, result FROM runs WHERE id = $1`, [runId]);
    const row = r.rows[0];
    if (row && row.status !== "running") return { id: runId, status: row.status, result: row.result };
    if (Date.now() - started > timeoutMs) { stopRun(runId); return { id: runId, status: "stopped", result: "Took too long." }; }
    await new Promise((res) => setTimeout(res, 300));
  }
}

async function execute(runId: string, projectId: string, board: Board, by: "isaak" | "it") {
  const project = await getProject(projectId);
  const models = board.pieces.filter((p) => p.type === "model");
  const outputs = new Map<string, Promise<string>>();
  const deliveries = new Map<string, { from: string; text: string }[]>();
  const resolvers = new Map<string, (() => void)[]>();
  const finals: { piece: string; text: string }[] = [];
  const deliveredFrom = (target: string) => (deliveries.get(target) ?? []);
  const incomingModels = (target: string) => board.arrows.filter((a) => a.to === target && board.pieces.find((p) => p.id === a.from)?.type === "model").map((a) => a.from);
  let strayRun = 0;

  const waitForInputs = (target: string) => new Promise<void>((resolve) => {
    const need = new Set(incomingModels(target));
    const check = () => { if ([...need].every((n) => deliveredFrom(target).some((d) => d.from === n))) resolve(); };
    (resolvers.get(target) ?? resolvers.set(target, []).get(target)!).push(check);
    check();
  });
  const deliver = (target: string, from: string, text: string) => {
    (deliveries.get(target) ?? deliveries.set(target, []).get(target)!).push({ from, text });
    for (const r of resolvers.get(target) ?? []) r();
  };

  const runModel = async (m: Piece): Promise<string> => {
    await waitForInputs(m.id);
    const packs = board.arrows.filter((a) => a.to === m.id && board.pieces.find((p) => p.id === a.from)?.type === "pack")
      .map((a) => board.pieces.find((p) => p.id === a.from)!);
    const packTexts: string[] = [];
    for (const p of packs) { try { packTexts.push(await packText(p.ref, p.version ?? "current")); } catch { packTexts.push(`(pack ${p.ref} is gone)`); } }
    // The raw sources its packs list: the ones it may open (Isaak, 16 Nov: the link is there so it can, if it judges it needs to).
    const openable = new Set(packTexts.flatMap((t) => [...t.matchAll(/^- s:(\S+)/gm)].map((x) => x[1])));
    const instructions = [board.runInstructions, m.instructions].filter((x) => x?.trim()).join("\n\nYOUR OWN INSTRUCTIONS: ") || "(no instructions: do what fits the context)";
    let context = [
      `PROJECT: ${project.title}${project.goal ? ` — ${project.goal}` : ""}`,
      `INSTRUCTIONS: ${instructions}`,
      packTexts.length ? `CONTEXT PACKS:\n${packTexts.join("\n\n")}` : "",
      deliveredFrom(m.id).length ? `HANDED TO YOU BY OTHER MODELS:\n${deliveredFrom(m.id).map((d) => `from ${d.from}:\n${d.text}`).join("\n\n")}` : "",
    ].filter(Boolean).join("\n\n");
    let current = "";
    const steps = board.arrows.filter((a) => a.from === m.id).sort((a, b) => (a.step ?? 999) - (b.step ?? 999));
    const think = async (what: string, webSearch = false, step?: number): Promise<string> => {
      if (stopRequested.has(runId)) throw new Error("stopped");
      const started = Date.now();
      let res = await callModel(m.ref, { task: "board-step", system: STEP_SYSTEM, prompt: `${context}${current ? `\n\nWHAT YOU HAVE SO FAR:\n${current}` : ""}\n\nNOW: ${what}`, webSearch, maxTokens: 8000 }, null);
      // It may open raw sources from its packs (a few rounds at most), then answers again with them in front of it.
      for (let round = 0; round < 3; round++) {
        const asked = [...res.text.matchAll(/^\s*OPEN s:(\S+)\s*$/gm)].map((x) => x[1]);
        const opened = asked.length ? await openSources(asked, openable) : "";
        if (!opened) break;
        await appendLog(runId, { at: new Date().toISOString(), piece: m.id, model: m.ref, step, kind: "opened-sources", input: what, output: asked.map((x) => `s:${x}`).join(", "), ms: 0 });
        context = `${context}\n\nRAW SOURCES YOU OPENED:\n${opened}`;
        res = await callModel(m.ref, { task: "board-step", system: STEP_SYSTEM, prompt: `${context}${current ? `\n\nWHAT YOU HAVE SO FAR:\n${current}` : ""}\n\nNOW: ${what}`, webSearch, maxTokens: 8000 }, null);
      }
      const { thoughts, output } = splitAnswer(res.text);
      await appendLog(runId, { at: new Date().toISOString(), piece: m.id, model: m.ref, step, kind: webSearch ? "web-search" : "call", input: what, thoughts, output, ms: Date.now() - started });
      if (by === "it") {
        const straying = await checkStraying(project.goal || project.title, "", `${what} — ${thoughts}`.slice(0, 1500));
        strayRun = straying ? strayRun + 1 : 0;
        if (strayRun >= 3) { stopRequested.add(runId); throw new Error("strayed three steps in a row"); }
      }
      return output;
    };
    if (!steps.length) {
      current = await think("Do the work and give your output.");
      finals.push({ piece: m.id, text: current });
      return current;
    }
    for (const [i, a] of steps.entries()) {
      const target = board.pieces.find((p) => p.id === a.to);
      if (!target) continue;
      const isLast = i === steps.length - 1;
      if (target.type === "module" && target.ref === "web-search") {
        current = await think(`Step ${a.step ?? i + 1}: search the web for what your instructions need, and report what you found with the pages you used.`, true, a.step);
      } else if (target.type === "model") {
        if (!current) current = await think(`Step ${a.step ?? i + 1}: write what you will hand to the next model (${target.ref}).`, false, a.step);
        await appendLog(runId, { at: new Date().toISOString(), piece: m.id, model: m.ref, step: a.step, kind: "hand-over", note: `to ${target.id}`, output: current });
        deliver(target.id, m.id, current);
      } else if (target.type === "me") {
        current = await think(`Step ${a.step ?? i + 1}: write ${isLast ? "your final result for Isaak" : "what you have so far for Isaak, and ask him what he wants next"}.`, false, a.step);
        if (isLast) { finals.push({ piece: m.id, text: current }); }
        else {
          // The need-input element: the run pauses here until he answers.
          await db().query(`UPDATE runs SET status = 'waiting', waiting_piece = $2 WHERE id = $1`, [runId, m.id]);
          await appendLog(runId, { at: new Date().toISOString(), piece: m.id, model: m.ref, step: a.step, kind: "waiting", output: current });
          if (by === "it") {
            await db().query(`UPDATE projects SET status = 'waiting' WHERE id = $1`, [projectId]);
            const { popup } = await import("./popups.js");
            await popup("question", `"${project.title}" needs your input`, current.slice(0, 3000), projectId);
            const { say } = await import("./chat.js");
            await say(`I need your input on my project "${project.title}": ${current} You can answer in the project.`, { projectId });
          }
          bump();
          const answer = await new Promise<string>((resolve) => waiters.set(runId, resolve));
          waiters.delete(runId);
          if (stopRequested.has(runId)) throw new Error("stopped");
          await db().query(`UPDATE runs SET status = 'running', waiting_piece = NULL WHERE id = $1`, [runId]);
          if (by === "it") await db().query(`UPDATE projects SET status = 'open' WHERE id = $1`, [projectId]);
          await appendLog(runId, { at: new Date().toISOString(), piece: "me", kind: "input", input: answer });
          context += `\n\nISAAK'S INPUT AFTER STEP ${a.step ?? i + 1}: ${answer}`;
        }
      } else if (target.type === "pack" || target.type === "result") {
        await appendLog(runId, { at: new Date().toISOString(), piece: m.id, kind: "note", note: `An arrow to a ${target.type} does nothing in a run.` });
      }
    }
    if (!finals.some((f) => f.piece === m.id) && !board.arrows.some((a) => a.from === m.id && board.pieces.find((p) => p.id === a.to)?.type === "model")) finals.push({ piece: m.id, text: current });
    return current;
  };

  for (const m of models) outputs.set(m.id, runModel(m));
  const settled = await Promise.allSettled([...outputs.values()]);
  const failed = settled.filter((s) => s.status === "rejected").map((s) => String((s as PromiseRejectedResult).reason?.message ?? s));
  const stopped = stopRequested.has(runId);
  stopRequested.delete(runId);
  let result = finals.map((f) => `${f.piece}:\n${f.text}`).join("\n\n");
  if (failed.length) result += `\n\n${stopped ? "Stopped" : "Problems"}: ${failed.join("; ")}`;
  let summary = result;
  await flushLog(runId);
  try {
    const log = (await db().query<{ log: string }>(`SELECT log FROM runs WHERE id = $1`, [runId])).rows[0]?.log ?? "[]";
    summary = (await call("web", { task: "run-summary", system: "Summarise this run of a board for Isaak: what each model did, what came out, in a few short paragraphs. Plain text.", prompt: `RESULTS:\n${result}\n\nTHE LOG:\n${log.slice(0, 60000)}`, maxTokens: 2000 })).text.trim();
  } catch { /* keep the raw result */ }
  const status = stopped ? "stopped" : failed.length && !finals.length ? "failed" : "done";
  await db().query(`UPDATE runs SET status = $2, result = $3, finished_at = now() WHERE id = $1`, [runId, status, `${summary}\n\n---\n${result}`]);
  // Every run gives a new result piece on the board.
  const { board: now } = await canon(projectId);
  const k = await known();
  k.runs.add(runId);
  const right = Math.max(400, ...now.pieces.map((p) => p.x)) + 220;
  now.pieces.push({ id: `result-${runId.slice(0, 6)}`, type: "result", ref: runId, label: `Result ${new Date().toISOString().slice(11, 16)}`, x: Math.min(right, 1400), y: 80 + now.pieces.filter((p) => p.type === "result").length * 90 });
  const cleaned = cleanBoard(now, k);
  const { version } = await canon(projectId);
  await db().query(`INSERT INTO boards (id, project_id, version, data) VALUES ($1,$2,$3,$4)`, [id(), projectId, version + 1, JSON.stringify(cleaned)]);
  await touch(projectId);
  bump();
}

// ---------- closing and reopening ----------

/** Close: the conversation, a screenshot of the board and the runs go in as raw files; the project summary is written into the web. */
export async function closeProject(projectId: string, screenshot?: Buffer | null, status: "closed" | "junction" = "closed"): Promise<string> {
  const project = await getProject(projectId);
  const view = await projectView(projectId);
  const sources: string[] = [];
  const convo = view.messages.map((m) => `${String(m.role).toUpperCase()} (${String(m.created_at).slice(0, 16)}): ${m.text}`).join("\n\n");
  sources.push(await addSource({ kind: "session-file", origin: "session", title: `Conversation of "${project.title}"`, text: convo || "(no conversation)", projectId }));
  if (screenshot?.length) {
    sources.push(await addSource({ kind: "session-file", origin: "session", title: `The board of "${project.title}"`, text: `A screenshot of the board of "${project.title}" at closing.\n\n${describeBoard(view.canon.board)}`, fileName: "board.png", mime: "image/png", bytes: screenshot, projectId }));
  } else {
    sources.push(await addSource({ kind: "session-file", origin: "session", title: `The board of "${project.title}"`, text: describeBoard(view.canon.board), projectId }));
  }
  for (const r of view.runs) {
    sources.push(await addSource({ kind: "session-file", origin: "session", title: `Run ${String(r.id).slice(0, 6)} of "${project.title}"`, text: `STATUS: ${r.status}\nRESULT:\n${r.result}\n\nTHE FULL LOG:\n${JSON.stringify(r.log, null, 1).slice(0, 200000)}`, projectId }));
  }
  if (project.proposal_id) {
    const p = (await db().query<{ title: string; body: string }>(`SELECT title, body FROM proposals WHERE id = $1`, [project.proposal_id])).rows[0];
    if (p) sources.push(await addSource({ kind: "proposal", origin: "self", title: `The proposal behind "${project.title}"`, text: p.body, projectId }));
  }
  await db().query(`UPDATE sources SET placed = true WHERE id = ANY($1)`, [sources]);
  const firstTime = !project.summary_id;
  const summaryId = project.summary_id ?? await projectSummary(projectId, project.title);
  for (const s of sources) await feed(summaryId, "source", s);
  await db().query(`UPDATE projects SET status = $3::text, closed_at = CASE WHEN $3::text = 'closed' THEN now() ELSE closed_at END, summary_id = $2 WHERE id = $1`, [projectId, summaryId, status]);
  bump();
  // The summary is written now (in the background); main results go in, and side findings that matter.
  void (async () => {
    try {
      await rewrite(summaryId, "This is the summary of a work session (a project). Log the main results, and also relevant side findings.");
      if (firstTime) await placeSummary(summaryId);
      else await markStale(await parentsOf(summaryId));
    } catch { /* stays outdated; rewritten when touched */ }
  })();
  return summaryId;
}

export async function reopen(projectId: string): Promise<void> {
  await getProject(projectId);
  await db().query(`UPDATE projects SET status = 'open', closed_at = NULL WHERE id = $1`, [projectId]);
  await touch(projectId);
  bump();
  wake();
}

/** From a project summary: "pick this back up". */
export async function pickUp(summaryId: string): Promise<string> {
  const s = await getSummary(summaryId);
  if (!s.project_id) throw new ValidationError("This summary is not a project's summary.");
  await reopen(s.project_id);
  return s.project_id;
}

export { askAi, freshen };
export const workModel = () => ROLE_MODEL.work;
