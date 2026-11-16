import { call, callJson, downRoles, ModelDownError, roleDown, type Role } from "./models.js";
import { bump, db, lightProject, onWake, setDoing } from "./state.js";
import { absorb, annotate, below as howTree, ensureHow, freshen, lifeAndInstructions, markStale, place, plain, staleSummaries, tagList, tagSource, tidy, unplaced } from "./web.js";
import { acceptSuggestion, canon, closeProject, getProject, runAndWait, talk } from "./projects.js";
import { createProposal } from "./proposals.js";
import { say } from "./chat.js";
import { popup } from "./popups.js";
import { HOW_I_WORK, facts } from "./about.js";
import { getKnob } from "./settings.js";

/**
 * Its own work (IDEA.md). It only sleeps when there is no work. Anything that comes in wakes it. In order:
 *  1. what came in: place it in the web;
 *  2. its own open projects, one at a time, its own choice which: design the board, run it, judge, go on, until a
 *     satisfying junction (then a summary and his input before continuing) or it needs him;
 *  3. its own thinking: proposals (as many as it likes), things to bring up (like files it can't read yet);
 *  4. outdated summaries, at the bottom of the list.
 */

let running = false;
let wakeUp: (() => void) | null = null;
let stopped = false;
let lastThinkAt = 0;
let lastThinkSourceCount = -1;

export function startAutonomy(): () => void {
  stopped = false;
  onWake(() => { if (wakeUp) { const w = wakeUp; wakeUp = null; w(); } });
  void loop();
  return () => { stopped = true; if (wakeUp) wakeUp(); };
}

async function sleep(ms: number) {
  await new Promise<void>((resolve) => { wakeUp = resolve; setTimeout(() => { if (wakeUp === resolve) wakeUp = null; resolve(); }, ms); });
}

async function loop() {
  if (running) return;
  running = true;
  while (!stopped) {
    let worked = false;
    try { worked = await oneStep(); } catch (error) { setDoing(""); console.error("own work:", error); }
    if (!worked) { setDoing(""); await sleep(60_000); }
  }
  running = false;
}

let lastProbe = 0;
/** A part that shut down comes back only when its model answers again: every five minutes it asks a tiny question. */
async function probe() {
  if (Date.now() - lastProbe < 5 * 60_000) return;
  lastProbe = Date.now();
  for (const d of downRoles()) {
    await call(d.role as Role, { task: "probe", system: "Answer with the single word: ok", prompt: "ok?", maxTokens: 20 }).catch(() => undefined);
  }
}

/** Placing one source, then tidying on the fly: does the tree still show the big picture, given what just came in? */
async function placeAndTidy(sourceId: string) {
  const r = await place(sourceId);
  const src = (await db().query<{ title: string; text: string; tags: string }>(`SELECT title, text, tags FROM sources WHERE id = $1`, [sourceId])).rows[0];
  const t = await tidy(`${src?.title ?? ""}\n${src?.text ?? ""}${tagList(src?.tags).length ? `\n[its tags: ${tagList(src?.tags).join(", ")}]` : ""}`).catch(() => ({ say: "", touched: [] as string[] }));
  if (t.say) await say(t.say);
  // "How I work" is read by every model, so it is written right away when something was filed into it.
  const howId = await ensureHow();
  const howStale = (await db().query(`SELECT 1 FROM summaries WHERE absorbed_at IS NULL AND stale = true AND (is_how = true OR id = ANY($1))`, [[...(await howTree(howId))]])).rows.length;
  if (howStale) { setDoing("Writing How I work"); await freshen([howId]).catch(() => undefined); }
  return r;
}

const metaHas = async (key: string) => (await db().query(`SELECT 1 FROM meta WHERE key = $1`, [key])).rows.length > 0;
const metaGet = async (key: string) => (await db().query<{ value: string }>(`SELECT value FROM meta WHERE key = $1`, [key])).rows[0]?.value ?? null;
const metaSet = (key: string, value: string) => db().query(`INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);

/**
 * Once (Isaak, 16 Nov), in this order: the old instructions summary is dissolved into what it sat under; the messages
 * that fed it are placed again, one at a time and oldest first, so the filer sorts them into "How I work" itself; then his message about the internship inbox is undone (what was made from it and after it goes, its two
 * proposals are dropped, the chat around it is cleared) and sent through the chat again.
 */
async function moveInstructionsOnce(): Promise<boolean> {
  if (roleDown("web")) return false;
  if (!(await metaHas("how-migrate:2026-11-16"))) {
    await ensureHow();
    if (!(await metaHas("how-migrate:start"))) {
      const old = (await db().query<{ id: string }>(`SELECT id FROM summaries WHERE is_instructions = true AND absorbed_at IS NULL LIMIT 1`)).rows[0];
      const list = old ? (await db().query<{ input_id: string }>(
        `SELECT f.input_id FROM feeds f JOIN sources s ON s.id = f.input_id WHERE f.summary_id = $1 AND f.input_type = 'source' ORDER BY s.created_at`, [old.id])).rows.map((r) => r.input_id) : [];
      await metaSet("how-migrate:list", JSON.stringify(list));
      await metaSet("how-migrate:start", new Date().toISOString());
      // The old summary goes first (its messages go to what it sat under), so the filer doesn't put them back into it.
      if (old) {
        await absorb(old.id).catch(() => undefined);
        await db().query(`UPDATE summaries SET is_instructions = false WHERE id = $1`, [old.id]);
      }
    }
    const list = JSON.parse((await metaGet("how-migrate:list")) ?? "[]") as string[];
    for (const sid of list) {
      if (await metaHas(`how-moved:${sid}`)) continue;
      await metaSet(`how-moved:${sid}`, "done");
      setDoing("Moving your instructions into How I work");
      await placeAndTidy(sid).catch(() => undefined);
      return true;
    }
    await metaSet("how-migrate:2026-11-16", new Date().toISOString());
    return true;
  }
  if (!(await metaHas("redo-inbox-message:2026-11-16"))) {
    await metaSet("redo-inbox-message:2026-11-16", new Date().toISOString());
    const start = (await metaGet("how-migrate:start")) ?? new Date().toISOString();
    const msg = (await db().query<{ id: string; text: string; created_at: string }>(
      `SELECT id, text, created_at FROM sources WHERE kind = 'message' AND origin = 'isaak' AND text LIKE 'alright you''ve got your first like functional usage%' ORDER BY created_at LIMIT 1`)).rows[0];
    if (!msg) return true;
    setDoing("Undoing your inbox message to put it through again");
    const later = (await db().query<{ id: string }>(
      `SELECT id FROM sources WHERE created_at >= $1 AND created_at < $2 AND kind IN ('message','reply','proposal')`, [msg.created_at, start])).rows.map((r) => r.id);
    const made = (await db().query<{ id: string }>(
      `SELECT id FROM summaries WHERE created_at >= $1 AND created_at < $2 AND is_life = false AND is_how = false AND role = '' AND absorbed_at IS NULL`, [msg.created_at, start])).rows.map((r) => r.id);
    const touched = (await db().query<{ summary_id: string }>(`SELECT DISTINCT summary_id FROM feeds WHERE input_type = 'source' AND input_id = ANY($1)`, [later])).rows.map((r) => r.summary_id);
    await db().query(`DELETE FROM feeds WHERE input_type = 'source' AND input_id = ANY($1)`, [later]);
    for (const sid of made) {
      touched.push(...(await db().query<{ summary_id: string }>(`SELECT summary_id FROM feeds WHERE input_type = 'summary' AND input_id = $1`, [sid])).rows.map((r) => r.summary_id));
      await db().query(`DELETE FROM feeds WHERE summary_id = $1 OR (input_type = 'summary' AND input_id = $1)`, [sid]);
      await db().query(`UPDATE summaries SET absorbed_at = now() WHERE id = $1`, [sid]);
    }
    await markStale([...new Set(touched)].filter((t) => !made.includes(t)));
    await db().query(`UPDATE chat SET deleted_at = now() WHERE source_id = ANY($1)`, [later]);
    await db().query(`UPDATE proposals SET status = 'dropped', decided_at = now(), why = 'Undone together with his inbox message, to put it through again (Isaak, 16 Nov).' WHERE created_at >= $1 AND created_at < $2 AND status = 'open'`, [msg.created_at, start]);
    await db().query(`DELETE FROM sources WHERE id = ANY($1)`, [later]);
    const { send } = await import("./chat.js");
    await send(msg.text);
    return true;
  }
  // Once more (Isaak, 16 Nov), after instructions came first in the filer's rules: what the first move did is wiped
  // (the links it made from the 13 messages, and the summaries made while it ran), and the 13 go through the filer again.
  if (!(await metaHas("how-migrate-2:2026-11-16"))) {
    const list = JSON.parse((await metaGet("how-migrate:list")) ?? "[]") as string[];
    if (!(await metaHas("how-migrate-2:wiped"))) {
      await metaSet("how-migrate-2:wiped", new Date().toISOString());
      const start = await metaGet("how-migrate:start");
      const end = await metaGet("redo-inbox-message:2026-11-16");
      if (start && end && list.length) {
        // The old summary's messages went to what it sat under when it was dissolved: those links stay.
        const keep = new Set(((await db().query<{ went_into: string }>(`SELECT went_into FROM summaries WHERE title = 'How Isaak wants me to work' AND absorbed_at IS NOT NULL ORDER BY absorbed_at DESC LIMIT 1`)).rows[0]?.went_into ?? "").split(",").filter(Boolean));
        const links = (await db().query<{ summary_id: string; input_id: string }>(
          `SELECT summary_id, input_id FROM feeds WHERE input_type = 'source' AND input_id = ANY($1) AND created_at > $2 AND created_at < $3`, [list, start, end])).rows.filter((l) => !keep.has(l.summary_id));
        for (const l of links) await db().query(`DELETE FROM feeds WHERE summary_id = $1 AND input_type = 'source' AND input_id = $2`, [l.summary_id, l.input_id]);
        await markStale([...new Set(links.map((l) => l.summary_id))]);
        // Summaries made while it ran go; what they held goes to what they sat under.
        const made = (await db().query<{ id: string }>(
          `SELECT id FROM summaries WHERE created_at > $1 AND created_at < $2 AND is_life = false AND is_how = false AND role = '' AND absorbed_at IS NULL ORDER BY created_at DESC`, [start, end])).rows.map((r) => r.id);
        for (const sid of made) await absorb(sid).catch(() => undefined);
      }
      return true;
    }
    for (const sid of list) {
      if (await metaHas(`how-moved-2:${sid}`)) continue;
      await metaSet(`how-moved-2:${sid}`, "done");
      setDoing("Moving your instructions into How I work");
      await placeAndTidy(sid).catch(() => undefined);
      return true;
    }
    await metaSet("how-migrate-2:2026-11-16", new Date().toISOString());
    return true;
  }
  return false;
}

/** One piece of work; false when there was nothing to do. */
export async function oneStep(): Promise<boolean> {
  await probe();
  if (!roleDown("web")) {
    const next = await unplaced(1);
    if (next[0]) {
      setDoing("Placing something new in the web");
      const placed = await placeAndTidy(next[0]).catch(async (error) => {
        // Gemini being down is not this source's fault: it waits for Gemini to come back.
        if (error instanceof ModelDownError) return;
        // A source that can't be placed for another reason should not block the rest.
        await db().query(`UPDATE sources SET placed = true WHERE id = $1`, [next[0]]);
        await db().query(`INSERT INTO activity (id, what, detail) VALUES (gen_random_uuid()::text, 'place failed', $1)`, [String((error as Error).message)]).catch(() => undefined);
      });
      return true;
    }
  }
  // Once (Isaak, 16 Nov): when everything is placed, one tidying pass over the whole tree as it is, so a tree built
  // before the layers gets the same judgement as new input would.
  if (!roleDown("web") && !(await db().query(`SELECT 1 FROM meta WHERE key = 'tidy-whole:2026-11-16'`)).rows.length) {
    await db().query(`INSERT INTO meta (key, value) VALUES ('tidy-whole:2026-11-16', $1)`, [new Date().toISOString()]);
    setDoing("Looking over the whole web");
    const t = await tidy("").catch(() => ({ say: "", touched: [] as string[] }));
    if (t.say) await say(t.say);
    return true;
  }
  // Once (Isaak, 16 Nov): everything that came in before tags existed gets its tags, one entry at a time, oldest
  // first; then one tidying pass over the tree and the tag pool together. Nothing is placed again.
  if (!roleDown("web") && !(await db().query(`SELECT 1 FROM meta WHERE key = 'tag-existing:2026-11-16'`)).rows.length) {
    await db().query(`INSERT INTO meta (key, value) VALUES ('tag-existing:start', $1) ON CONFLICT (key) DO NOTHING`, [new Date().toISOString()]);
    const start = (await db().query<{ value: string }>(`SELECT value FROM meta WHERE key = 'tag-existing:start'`)).rows[0].value;
    const next = (await db().query<{ id: string }>(`SELECT id FROM sources WHERE tags = '[]' AND placed = true AND created_at < $1 AND ('tagged-once:' || id) NOT IN (SELECT key FROM meta WHERE key LIKE 'tagged-once:%') ORDER BY created_at LIMIT 1`, [start])).rows[0];
    if (next) {
      setDoing("Tagging what came in before tags existed");
      await tagSource(next.id).catch(() => undefined);
      // An entry it gave no tags still counts as done, so the pass ends.
      await db().query(`INSERT INTO meta (key, value) VALUES ($1, 'done') ON CONFLICT (key) DO NOTHING`, [`tagged-once:${next.id}`]);
      return true;
    }
    await db().query(`INSERT INTO meta (key, value) VALUES ('tag-existing:2026-11-16', $1)`, [new Date().toISOString()]);
    setDoing("Looking over the whole web and its tags");
    const t = await tidy("").catch(() => ({ say: "", touched: [] as string[] }));
    if (t.say) await say(t.say);
    return true;
  }
  if (await moveInstructionsOnce()) return true;
  const own = Boolean(await getKnob("ownWork"));
  if (own && !roleDown("work")) {
    const project = await pickProject();
    if (project) { await workOn(project); return true; }
    if (await think()) return true;
  }
  if (own && !roleDown("web")) {
    const stale = await staleSummaries(1);
    if (stale[0]) { setDoing("Updating an outdated summary"); await freshen(stale); return true; }
  }
  return false;
}

async function pickProject(): Promise<string | null> {
  const r = await db().query<{ id: string; title: string; goal: string }>(`SELECT id, title, goal FROM projects WHERE owner = 'it' AND status = 'open' ORDER BY last_active_at`);
  if (!r.rows.length) return null;
  if (r.rows.length === 1) return r.rows[0].id;
  // One at a time, its own choice which.
  try {
    const out = await callJson<{ pick?: string }>("work", {
      task: "pick-project",
      system: "You work on your own projects one at a time. Pick the one to work on now. Answer with one JSON object: {\"pick\": \"project id\"}",
      prompt: r.rows.map((p) => `- ${p.id} | ${p.title} | ${p.goal.slice(0, 300)}`).join("\n"),
      maxTokens: 300,
    });
    return r.rows.find((p) => p.id === out.pick)?.id ?? r.rows[0].id;
  } catch { return r.rows[0].id; }
}

const JUDGE_SYSTEM = `You are working on one of your own projects in Isaak's workspace, on your own. You just ran a round on its board. Judge where it stands:
- "continue": there is more to do; say in "next" what the next round should do;
- "junction": you reached a satisfying junction; before continuing you ask Isaak for his input (say what in "ask");
- "need_input": you can't go on without him (say what you need in "ask").
Answer with one JSON object: {"state": "continue" | "junction" | "need_input", "next": "", "ask": "", "say": "one or two sentences for the chat if he should know something now, else empty"}`;

async function workOn(projectId: string) {
  const project = await getProject(projectId);
  setDoing(`Working on my project "${project.title}"`);
  lightProject(projectId);
  const last = await db().query<{ result: string }>(`SELECT result FROM runs WHERE project_id = $1 ORDER BY started_at DESC LIMIT 1`, [projectId]);
  const nextHint = await db().query<{ text: string }>(`SELECT text FROM project_messages WHERE project_id = $1 AND role = 'it-note' ORDER BY created_at DESC LIMIT 1`, [projectId]);
  const self = last.rows[0]
    ? `Working on your own. The last round's result is above. ${nextHint.rows[0]?.text ? `Your plan for this round: ${nextHint.rows[0].text}. ` : ""}Design the board for the next round (change what needs changing) and run it.`
    : `Working on your own. This is the first round of your project. Its goal: ${project.goal}. Design the board for it and run it.`;
  const { reply, proposed } = await talk(projectId, self, "it");
  if (proposed) {
    const msg = await db().query<{ id: string }>(`SELECT id FROM project_messages WHERE project_id = $1 AND proposed_board IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [projectId]);
    if (msg.rows[0]) await acceptSuggestion(projectId, msg.rows[0].id);
  }
  const { board } = await canon(projectId);
  if (!board.pieces.some((p) => p.type === "model")) {
    await db().query(`UPDATE projects SET status = 'waiting' WHERE id = $1`, [projectId]);
    await say(`I got stuck on my project "${project.title}": I couldn't build a board to run (${reply.slice(0, 300)}). Could you take a look in the project?`, { projectId });
    return;
  }
  const run = await runAndWait(projectId, "it");
  if (run.status === "waiting") return; // the "me" element: the run waits for his answer; it said so in the chat
  if (run.status === "stopped" || run.status === "failed") {
    await db().query(`UPDATE projects SET status = 'waiting' WHERE id = $1`, [projectId]);
    await say(`My project "${project.title}" stopped (${run.status}): ${run.result.slice(0, 400)} I'll wait for you before going on.`, { projectId });
    await popup("question", `"${project.title}" stopped`, run.result.slice(0, 2000), projectId);
    return;
  }
  const judge = await callJson<{ state?: string; next?: string; ask?: string; say?: string }>("work", {
    task: "judge-round",
    system: JUDGE_SYSTEM,
    prompt: `PROJECT "${project.title}"\nGOAL: ${project.goal}\n\nTHE ROUND'S RESULT:\n${run.result.slice(0, 20000)}`,
    maxTokens: 1500,
  });
  const state = judge.state === "junction" || judge.state === "need_input" ? judge.state : "continue";
  if (state === "continue") {
    await db().query(`INSERT INTO project_messages (id, project_id, role, text) VALUES (gen_random_uuid()::text, $1, 'it-note', $2)`, [projectId, String(judge.next ?? "").slice(0, 4000)]);
    if (judge.say?.trim()) await say(judge.say.trim(), { projectId });
    return;
  }
  // A junction: it writes the summary, just like when they work on it together, and asks before going on.
  if (state === "junction") await closeProject(projectId, null, "junction");
  else await db().query(`UPDATE projects SET status = 'waiting' WHERE id = $1`, [projectId]);
  const ask = String(judge.ask ?? "What do you think, and how should I go on?");
  await say(`${state === "junction" ? `I reached a good point in my project "${project.title}" and wrote its summary.` : `I need you on my project "${project.title}".`} ${ask}`, { projectId });
  await popup("question", `"${project.title}": ${state === "junction" ? "a good point to check in" : "needs your input"}`, ask, projectId);
  bump();
}

const THINK_SYSTEM = `You have your own time in Isaak's personal system.

${HOW_I_WORK}

You may propose projects of your own: as many as you like, each with what and why, as long as each one is accurate and current and covers its own ground: proposals must not overlap with each other or with proposals he has already seen. You may always revisit an idea if it is worth it. You may also bring something up in the chat (for example files you can't read yet), when you judge it is useful now. If nothing is worth doing, do nothing.
Answer with one JSON object: {"proposals": [{"title": "", "body": "what and why"}], "say": "something for the chat, or empty"}`;

/** Its own thinking: proposals and things to bring up. Only when something new came in since it last thought. */
async function think(): Promise<boolean> {
  const count = Number((await db().query<{ n: string }>(`SELECT count(*) AS n FROM sources WHERE kind NOT IN ('reply','proposal')`)).rows[0]?.n ?? 0);
  if (count === lastThinkSourceCount || count === 0) return false;
  lastThinkAt = Date.now();
  lastThinkSourceCount = count;
  setDoing("Thinking about what to propose");
  const { life, instructions } = await lifeAndInstructions();
  const proposals = await db().query<{ title: string; status: string; why: string }>(`SELECT title, status, why FROM proposals ORDER BY created_at DESC LIMIT 40`);
  const unreadable = await db().query<{ file_name: string; created_at: string }>(`SELECT file_name, created_at FROM sources WHERE readable = false ORDER BY created_at DESC LIMIT 20`);
  const recent = await db().query<{ title: string; text: string; kind: string }>(`SELECT title, CASE WHEN kind = 'file' THEN left(text, 4000) ELSE text END AS text, kind FROM sources WHERE origin = 'isaak' ORDER BY created_at DESC LIMIT 15`);
  const out = await callJson<{ proposals?: { title?: string; body?: string }[]; say?: string }>("work", {
    task: "own-time",
    system: THINK_SYSTEM,
    prompt: [
      await facts(),
      `MY LIFE:\n${(await annotate(life.body)) || "(empty)"}`,
      instructions ? `HOW ISAAK WANTS YOU TO WORK:\n${await annotate(instructions.body)}` : "",
      `WHAT HE SAID AND GAVE LATELY:\n${recent.rows.map((r) => `- ${r.kind}: ${r.title} ${r.text}`).join("\n") || "(nothing)"}`,
      `PROPOSALS SO FAR:\n${proposals.rows.map((p) => `- ${p.title} (${p.status}${p.why ? `: ${p.why}` : ""})`).join("\n") || "(none)"}`,
      unreadable.rows.length ? `FILES YOU CAN'T READ YET:\n${unreadable.rows.map((u) => `- ${u.file_name} (${String(u.created_at).slice(0, 10)})`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n"),
    maxTokens: 3000,
  });
  for (const p of out.proposals ?? []) {
    if (!p?.title?.trim() || !p.body?.trim()) continue;
    // Isaak, 15 Nov: before creating a proposal it thinks for a second to be sure this proposal, or part of it, isn't already covered by another.
    if (await alreadyCovered(p.title, p.body)) continue;
    await createProposal({ title: p.title, body: p.body });
  }
  if (out.say?.trim()) await say(out.say.trim());
  return true;
}

async function alreadyCovered(title: string, body: string): Promise<boolean> {
  const all = await db().query<{ title: string; body: string; status: string; why: string }>(`SELECT title, body, status, why FROM proposals ORDER BY created_at DESC`);
  if (!all.rows.length) return false;
  try {
    const out = await callJson<{ covered?: boolean }>("work", {
      task: "proposal-overlap",
      system: `Before you create a proposal, you check that it covers its own ground: that this proposal, or part of it, is not already covered by another proposal (open, accepted, declined or dropped). Answer with one JSON object: {"covered": true or false, "why": "one line"}`,
      prompt: `NEW PROPOSAL "${title}":\n${body}\n\nEXISTING PROPOSALS:\n${all.rows.map((p) => `- "${p.title}" (${p.status}${p.why ? `: ${p.why}` : ""}): ${p.body.slice(0, 1500)}`).join("\n")}`,
      maxTokens: 400,
    });
    return Boolean(out.covered);
  } catch { return false; }
}

export function resetThinkForTests() { lastThinkAt = 0; lastThinkSourceCount = -1; }
