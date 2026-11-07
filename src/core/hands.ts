import { readFileSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { assertNotDelete, assertNotSigningIn } from "../boundaries.js";
import { BoundaryError } from "../errors.js";
import { mapNode, mapPaths, SYSTEM_MAP } from "../self/map.js";
import { addCalendar, archiveCalendar, moveCalendar } from "./accounts.js";
import { embedOwners } from "./embed.js";
import { find, near, render, similar, web, type Ref } from "./look.js";
import { createPage, findPageByTitle, getPage, lifeDocument, pagesContaining, revisePage, type PageKind } from "./pages.js";
import { enqueue } from "./queue.js";
import { addEntry, addLink, archiveBrick, createBrick, getBrick, getSource, json, listEntries, linksOf, updateBrick } from "./store.js";
import { logStep, timed, type RunCtx } from "./steps.js";
import { staleByMembership } from "./upkeep.js";
import { addGoal, closeGoal, putOnBench, stepGoal, type BenchKind } from "./workshop.js";

/**
 * Hands (BUILD_SPEC §5.7): the seed set. Everything else arrives through its own requests.
 * Every act passes the boundaries check in code first (Isaak's boundaries: free / ask first / never).
 */
type Args = Record<string, unknown>;
interface Hand { node: string; args: string; about: string; run: (ctx: RunCtx, args: Args) => Promise<string> }

const s = (v: unknown) => (v == null ? "" : String(v));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : [String(v)]);

const REPO_ROOT = process.cwd();
const READABLE = [/^src\//, /^server\//, /^client\/src\//, /^tests\//, /^docs\//, /^[A-Z_]+\.md$/, /^package\.json$/];

export const HANDS: Record<string, Hand> = {
  // ---- looking ----
  find: { node: "hands/hlook", args: "query", about: "search bricks, pages and sources by words", run: async (ctx, a) => refsText(await find(ctx, s(a.query))) },
  similar: { node: "hands/hlook", args: "query", about: "search by meaning", run: async (ctx, a) => refsText((await similar(ctx, s(a.query))).refs) },
  near: { node: "hands/hlook", args: "id", about: "what is linked to a brick or page, strongest first", run: async (ctx, a) => refsText(await near(ctx, s(a.id))) },
  open: { node: "hands/hlook", args: "id (brick, page or source)", about: "read one thing in full", run: async (ctx, a) => (await openAny(ctx, s(a.id))).slice(0, 20_000) },
  web: { node: "hands/hlook", args: "query", about: "search the internet (never private details; code refuses them)", run: async (ctx, a) => (await web(ctx, s(a.query))).text.slice(0, 8000) },

  // ---- web work ----
  link: {
    node: "hands/hweb", args: "a, b, relation, reason", about: "a judged link between two bricks or pages (answers a need, supports, contradicts, causes, part of, involves, updates, insight…)",
    run: async (ctx, a) => { const l = await addLink(ctx, { a: s(a.a), b: s(a.b), relation: s(a.relation) || "relevant to", reason: s(a.reason), madeBy: "run" }); return l ? `linked ${l.a} ↔ ${l.b} (${l.relation})` : "not linked (same thing)"; },
  },
  merge: {
    node: "hands/hweb", args: "keep, drop, why", about: "two bricks are one thing: move everything from drop to keep, archive drop",
    run: async (ctx, a) => {
      const keep = await getBrick(ctx, s(a.keep)); const drop = await getBrick(ctx, s(a.drop));
      if (!keep || !drop) throw new Error("merge needs two existing bricks");
      await ctx.db.query(`UPDATE entries SET brick_id=$3 WHERE user_id=$1 AND brick_id=$2`, [ctx.userId, drop.id, keep.id]);
      await ctx.db.query(`UPDATE links SET a=$3 WHERE user_id=$1 AND a=$2`, [ctx.userId, drop.id, keep.id]);
      await ctx.db.query(`UPDATE links SET b=$3 WHERE user_id=$1 AND b=$2`, [ctx.userId, drop.id, keep.id]);
      await ctx.db.query(`UPDATE page_members SET member_id=$3 WHERE user_id=$1 AND member_kind='brick' AND member_id=$2`, [ctx.userId, drop.id, keep.id]);
      await addEntry(ctx, { brickId: keep.id, kind: "merge", text: `Merged "${drop.name}" into this brick: ${s(a.why)}`, origin: "own" });
      await archiveBrick(ctx, drop.id);
      await staleByMembership(ctx, [keep.id], `merged "${drop.name}" into "${keep.name}"`, `merge:${drop.id}`);
      return `merged "${drop.name}" into "${keep.name}"`;
    },
  },
  split: {
    node: "hands/hweb", args: "id, parts: [{name, summary, entry_ids}]", about: "one brick is really several things",
    run: async (ctx, a) => {
      const orig = await getBrick(ctx, s(a.id));
      if (!orig) throw new Error("split needs an existing brick");
      const parts = (Array.isArray(a.parts) ? a.parts : []) as { name?: string; summary?: string; entry_ids?: string[] }[];
      const made: string[] = [];
      for (const p of parts) {
        if (!p.name) continue;
        const b = await createBrick(ctx, { name: p.name, summary: p.summary ?? "", kind: orig.kind, corner: orig.corner });
        for (const e of p.entry_ids ?? []) await ctx.db.query(`UPDATE entries SET brick_id=$3 WHERE user_id=$1 AND id=$2 AND brick_id=$4`, [ctx.userId, e, b.id, orig.id]);
        await addLink(ctx, { a: b.id, b: orig.id, relation: "split from", reason: "split by a run", madeBy: "run" });
        made.push(b.name);
      }
      await staleByMembership(ctx, [orig.id], `split "${orig.name}"`, `split:${orig.id}`);
      return `split "${orig.name}" into ${made.join(", ")}`;
    },
  },
  relabel: {
    node: "hands/hweb", args: "id, name?, kind?, summary?, corner?", about: "rename or re-describe a brick",
    run: async (ctx, a) => { await updateBrick(ctx, s(a.id), { name: a.name ? s(a.name) : undefined, kind: a.kind ? s(a.kind) : undefined, summary: a.summary ? s(a.summary) : undefined, corner: a.corner === "own" ? "own" : a.corner === "his" ? "his" : undefined }); await embedBrick(ctx, s(a.id)); return `relabelled ${s(a.id)}`; },
  },
  write_page: {
    node: "hands/hweb", args: "title, purpose, body (cites [[b:]] [[p:]] [[s:]]), kind? (page|life|guide|track|project)", about: "write a new page; code refuses citations that don't exist",
    run: async (ctx, a) => {
      const kind = (["page", "life", "guide", "track", "project"].includes(s(a.kind)) ? s(a.kind) : "page") as PageKind;
      const existing = kind === "life" ? await lifeDocument(ctx) : await findPageByTitle(ctx, s(a.title));
      if (existing) {
        const p = await revisePage(ctx, existing.id, { body: s(a.body), purpose: a.purpose ? s(a.purpose) : undefined, changeNote: s(a.change_note) || "rewritten by a run", claimChanged: true });
        return `revised [[p:${p.id}]] "${p.title}" to version ${p.version}`;
      }
      const p = await createPage(ctx, { kind, title: s(a.title), purpose: s(a.purpose), body: s(a.body) });
      return `wrote [[p:${p.id}]] "${p.title}"`;
    },
  },
  revise_page: {
    node: "hands/hweb", args: "id, body, change_note, claim_changed", about: "a new version of a page (every version is kept)",
    run: async (ctx, a) => { const p = await revisePage(ctx, s(a.id), { body: s(a.body), changeNote: s(a.change_note), claimChanged: a.claim_changed !== false }); return `revised [[p:${p.id}]] to version ${p.version}`; },
  },

  // ---- calendar, goals, schedule ----
  calendar_add: { node: "hands/hcal", args: "title, start (ISO), end?, why", about: "add to Isaak's calendar (free)", run: async (ctx, a) => `added event ${await addCalendar(ctx, { title: s(a.title), startsAt: s(a.start), endsAt: a.end ? s(a.end) : undefined, why: s(a.why), source: "its" })}` },
  calendar_move: { node: "hands/hcal", args: "id, start, end?", about: "move an event", run: async (ctx, a) => { await moveCalendar(ctx, s(a.id), s(a.start), a.end ? s(a.end) : undefined); return `moved ${s(a.id)}`; } },
  calendar_archive: { node: "hands/hcal", args: "id, why", about: "archive an event (never delete)", run: async (ctx, a) => { await archiveCalendar(ctx, s(a.id)); return `archived ${s(a.id)}`; } },
  goal_add: { node: "hands/hcal", args: "text, why, target? (self or a project page id)", about: "start a goal: your ongoing work", run: async (ctx, a) => `goal ${(await addGoal(ctx, { text: s(a.text), why: s(a.why), target: s(a.target) || "self" })).id}` },
  goal_step: { node: "hands/hcal", args: "id, note", about: "record a step on a goal", run: async (ctx, a) => { await stepGoal(ctx, s(a.id), s(a.note)); return `stepped ${s(a.id)}`; } },
  goal_close: { node: "hands/hcal", args: "id, why", about: "close a goal", run: async (ctx, a) => { await closeGoal(ctx, s(a.id), s(a.why)); return `closed ${s(a.id)}`; } },
  schedule_run: {
    node: "hands/hcal", args: "at (ISO), purpose, why, goal_id?", about: "queue a run of your own for later: how promises are kept (any number)",
    run: async (ctx, a) => {
      const at = new Date(s(a.at));
      if (Number.isNaN(at.getTime())) throw new Error(`schedule_run needs a time, got "${s(a.at)}"`);
      const run = await enqueue(ctx, { trigger: "schedule", job: "own", purpose: s(a.purpose), why: s(a.why), dueAt: at.toISOString(), parentGoalId: a.goal_id ? s(a.goal_id) : null });
      if (a.goal_id) await stepGoal(ctx, s(a.goal_id), `next run ${at.toISOString()}: ${s(a.purpose)}`, run.id);
      await logStep(ctx, { node: "queue/tsched", kind: "event", label: `Scheduled for ${at.toISOString().slice(0, 16)}: ${s(a.purpose)}`.slice(0, 300) });
      return `scheduled run ${run.id} at ${at.toISOString()}`;
    },
  },

  // ---- Isaak's bench ----
  bench: {
    node: "hands/hbench", args: "kind (draft|suggestion|question|checkin), title, body, target?", about: "put something on Isaak's bench (nothing is sent anywhere)",
    run: async (ctx, a) => {
      const kind = (["draft", "suggestion", "question", "checkin"].includes(s(a.kind)) ? s(a.kind) : "suggestion") as BenchKind;
      const item = await putOnBench(ctx, { kind, title: s(a.title), body: s(a.body), target: s(a.target) || "self" });
      await logStep(ctx, { node: "workshop/wbench", kind: "event", label: `On your bench: ${kind}: ${item.title}`.slice(0, 300) });
      return `on the bench: ${item.id}`;
    },
  },

  // ---- self-inspection (read-only) ----
  inspect: { node: "hands/hself", args: "what (runs|steps|requests|bench|goals|stale|sources|reports|pages|links), run_id?, contains?, limit?", about: "query your own records", run: (ctx, a) => inspect(ctx, a) },
  audit_file: { node: "hands/hself", args: "source_id", about: "a source next to its bricks and quotes: what was skipped", run: (ctx, a) => auditFile(ctx, s(a.source_id)) },
  trace_run: { node: "hands/hself", args: "run_id", about: "replay a past run's gather: what it chose, what it used, what else was there", run: (ctx, a) => traceRun(ctx, s(a.run_id)) },
  read_code: { node: "hands/hself", args: "path (a file of your code, or 'map')", about: "read your own code or your system map", run: async (_ctx, a) => readCode(s(a.path)) },
  explain: { node: "hands/hself", args: "paths: [map paths]", about: "the map's own description of parts of you; the view points at them", run: async (_ctx, a) => explainPaths(list(a.paths)) },
};

const GROUPS: [string, string[]][] = [
  ["Looking", ["find", "similar", "near", "open", "web"]],
  ["Web work", ["link", "merge", "split", "relabel", "write_page", "revise_page"]],
  ["Calendar, goals, schedule", ["calendar_add", "calendar_move", "calendar_archive", "goal_add", "goal_step", "goal_close", "schedule_run"]],
  ["Isaak's bench", ["bench"]],
  ["Looking at yourself (read-only)", ["inspect", "audit_file", "trace_run", "read_code", "explain"]],
];

export function handCatalogue(): string {
  return GROUPS.map(([title, names]) => `${title}: ${names.map((n) => `${n}(${HANDS[n].args}) — ${HANDS[n].about}`).join("; ")}`).join("\n") +
    "\nNot in the seed: email, Drive, messaging, audio/video/images, sending anything, phone notifications, coding on projects. Ask for what you lack: a request, with evidence.";
}

/** The boundaries check (code): never delete, never sign in, never send. Then the hand. Every act is a step. */
export async function act(ctx: RunCtx, name: string, args: Args): Promise<{ ok: boolean; result: string }> {
  try {
    assertNotDelete(name);
    assertNotSigningIn(name);
    if (/^(send|post|reply|email|message|invite)/i.test(name)) throw new BoundaryError("Nothing is sent on Isaak's behalf. Put a draft on his bench instead.");
    const hand = HANDS[name];
    if (!hand) throw new Error(`No hand "${name}". If you need it, ask for it (a request).`);
    await logStep(ctx, { node: "hands/bcheck", kind: "event", label: `Boundaries check: ${name} is allowed` });
    const result = await timed(ctx, hand.node, "act", `${name}: ${summarise(args)}`, () => hand.run(ctx, args), (r) => ({ detail: { args, result: r.slice(0, 2000) } }));
    return { ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof BoundaryError) await logStep(ctx, { node: "hands/bcheck", kind: "event", label: `Blocked by a boundary: ${name}: ${message}`.slice(0, 300), ok: false, detail: { args } });
    return { ok: false, result: message };
  }
}

const summarise = (args: Args) => Object.entries(args).map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 60)}`).join(", ").slice(0, 200);

function refsText(refs: Ref[]): string {
  return refs.map((r) => `${r.kind} ${r.id}${r.title ? ` "${r.title}"` : ""}${r.why ? ` (${r.why})` : ""}`).join("\n") || "nothing found";
}

async function openAny(ctx: RunCtx, nodeId: string): Promise<string> {
  if (nodeId.startsWith("map:")) return explainPaths([nodeId.slice(4)]);
  if (nodeId.startsWith("code:")) return readCode(nodeId.slice(5));
  const clean = nodeId.replace(/^[bps]:/, "");
  for (const kind of ["brick", "page", "source"] as const) {
    const text = await render(ctx, { kind, id: clean });
    if (text) return text;
  }
  return `nothing with id ${nodeId}`;
}

async function embedBrick(ctx: RunCtx, brickId: string): Promise<void> {
  const b = await getBrick(ctx, brickId);
  if (b) await embedOwners(ctx, [{ kind: "brick", id: b.id, text: `${b.name}. ${b.summary}` }]);
}

export function readCode(path: string): string {
  if (!path || path === "map") return JSON.stringify(SYSTEM_MAP).slice(0, 60_000);
  const clean = normalize(path).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
  if (!READABLE.some((r) => r.test(clean)) || /\.env/.test(clean)) return `Not readable: ${path}. Readable: your code in src/, server/, client/src/, tests/, docs/ and the top-level .md files.`;
  const full = join(REPO_ROOT, clean);
  if (!existsSync(full)) return `No such file: ${clean}`;
  return readFileSync(full, "utf8").slice(0, 60_000);
}

export function explainPaths(paths: string[]): string {
  const known = new Set(mapPaths());
  return paths.map((p) => {
    if (!known.has(p)) return `${p}: not a part of the map`;
    const n = mapNode(p)!;
    return `[[map:${p}|${n.t}]] (${n.k ?? "c"}) ${n.s ?? ""}\n${n.d ?? ""}${n.kids ? `\nInside: ${Object.entries(n.kids).map(([k, v]) => `${p}/${k} ${v.t}`).join("; ")}` : ""}`;
  }).join("\n\n");
}

const INSPECTABLE: Record<string, string> = {
  runs: `SELECT id, trigger, job, purpose, status, created_at, started_at, ended_at, error FROM runs WHERE user_id=$1`,
  steps: `SELECT run_id, node, kind, label, model, ms, ok, at FROM run_steps WHERE user_id=$1`,
  requests: `SELECT id, title, kind, status, evidence_count, protected, his_decision, his_why FROM requests WHERE user_id=$1`,
  bench: `SELECT id, kind, title, status, his_note, created_at FROM bench WHERE user_id=$1`,
  goals: `SELECT id, text, status, steps FROM goals WHERE user_id=$1`,
  stale: `SELECT page_id, route, reason, triage, triage_why, done_at FROM stale_marks WHERE user_id=$1`,
  sources: `SELECT id, kind, title, orig_size, stored_size, filed, failed_parts FROM sources WHERE user_id=$1 AND archived_at IS NULL`,
  reports: `SELECT id, scale, period, left(body, 2000) AS body FROM reports WHERE user_id=$1`,
  pages: `SELECT id, kind, title, purpose, status, version FROM pages WHERE user_id=$1 AND archived_at IS NULL`,
  links: `SELECT a, b, relation, reason, made_by FROM links WHERE user_id=$1 AND archived_at IS NULL`,
};

async function inspect(ctx: RunCtx, a: Args): Promise<string> {
  const what = s(a.what);
  const base = INSPECTABLE[what];
  if (!base) return `inspect one of: ${Object.keys(INSPECTABLE).join(", ")}`;
  const params: unknown[] = [ctx.userId];
  let sql = base;
  if (a.run_id && (what === "steps")) { params.push(s(a.run_id)); sql += ` AND run_id=$${params.length}`; }
  const textColumn: Record<string, string> = { runs: "purpose", steps: "label", requests: "title", bench: "title", goals: "text", stale: "reason", sources: "title", reports: "body", pages: "title", links: "reason" };
  if (a.contains) { params.push(`%${s(a.contains)}%`); sql += ` AND ${textColumn[what]} ILIKE $${params.length}`; }
  sql += what === "steps" ? ` ORDER BY at DESC` : ` ORDER BY created_at DESC`;
  params.push(Math.min(100, Number(a.limit ?? 30)));
  sql += ` LIMIT $${params.length}`;
  const r = await ctx.db.query(sql, params);
  return r.rows.map((row) => JSON.stringify(row)).join("\n").slice(0, 20_000) || "no rows";
}

/** A source next to its bricks: how much of it is quoted, and which paragraphs nothing came from. */
export async function auditFile(ctx: RunCtx, sourceId: string): Promise<string> {
  const source = await getSource(ctx, sourceId);
  if (!source) return `no source ${sourceId}`;
  const r = await ctx.db.query<{ char_start: number | null; char_end: number | null; brick_id: string }>(`SELECT char_start, char_end, brick_id FROM entries WHERE user_id=$1 AND source_id=$2 AND archived_at IS NULL`, [ctx.userId, sourceId]);
  const covered = new Array<boolean>(source.body.length).fill(false);
  for (const e of r.rows) if (e.char_start != null && e.char_end != null) for (let i = e.char_start; i < Math.min(e.char_end, covered.length); i += 1) covered[i] = true;
  const quoted = covered.filter(Boolean).length;
  const paragraphs: { at: number; text: string }[] = [];
  let at = 0;
  for (const p of source.body.split(/\n\s*\n/)) { paragraphs.push({ at, text: p }); at += p.length + 2; }
  const untouched = paragraphs.filter((p) => p.text.trim().length > 40 && !covered.slice(p.at, p.at + p.text.length).some(Boolean));
  const bricks = new Set(r.rows.map((e) => e.brick_id));
  return [
    `Source [[s:${source.id}]] "${source.title}": ${source.body.length} characters stored of ${source.origSize} original${source.origSize > source.storedSize ? " (CUT OFF)" : ""}.`,
    `Quoted: ${source.body.length ? Math.round((quoted / source.body.length) * 100) : 0}% of the text, by ${r.rows.length} entries on ${bricks.size} bricks. Failed parts: ${source.failedParts.length}.`,
    untouched.length ? `Paragraphs nothing was filed from (${untouched.length}):\n${untouched.slice(0, 12).map((p) => `- at ${p.at}: ${p.text.slice(0, 200).replace(/\s+/g, " ")}`).join("\n")}` : "Every paragraph gave at least one quote.",
  ].join("\n");
}

/** Replay a past gather with hindsight: what it chose and why, what the pack held, what was used, and what else exists now. */
export async function traceRun(ctx: RunCtx, runId: string): Promise<string> {
  const run = (await ctx.db.query(`SELECT purpose, input FROM runs WHERE user_id=$1 AND id=$2`, [ctx.userId, runId])).rows[0];
  if (!run) return `no run ${runId}`;
  const pack = (await ctx.db.query<{ contents: string; used: string }>(`SELECT contents, used FROM packs WHERE user_id=$1 AND run_id=$2`, [ctx.userId, runId])).rows[0];
  const plan = (await ctx.db.query<{ detail: string }>(`SELECT detail FROM run_steps WHERE user_id=$1 AND run_id=$2 AND node='run/gather/gplan' LIMIT 1`, [ctx.userId, runId])).rows[0];
  const contents = json<{ kind: string; id: string; chars?: number; why?: string }[]>(pack?.contents, []);
  const used = new Set(json<string[]>(pack?.used, []));
  const input = json<{ message?: string }>(run.input, {});
  const now = await find(ctx, `${run.purpose} ${input.message ?? ""}`, 15);
  const missed = now.filter((r) => !contents.some((c) => c.id === r.id));
  return [
    `Run ${runId}: ${run.purpose}`,
    `Gather plan: ${plan ? JSON.stringify(json(plan.detail, {})).slice(0, 2000) : "none recorded"}`,
    `Pack (${contents.length} items, ${contents.reduce((n, c) => n + (c.chars ?? 0), 0)} chars): ${contents.map((c) => `${c.kind}:${c.id}${used.has(c.id) ? " (used)" : ""}`).join(", ")}`,
    `Used: ${used.size} of ${contents.length}.`,
    `What a word search finds today that the pack did not hold: ${missed.map((m) => `${m.kind}:${m.id} "${m.title ?? ""}"`).join(", ") || "nothing"}`,
  ].join("\n");
}

/** Used by intake and the engine: the brick's own text, for its meaning vector. */
export async function brickText(ctx: RunCtx, brickId: string): Promise<string> {
  const b = await getBrick(ctx, brickId);
  if (!b) return "";
  const entries = await listEntries(ctx, brickId, false);
  return `${b.name}. ${b.summary}. ${entries.slice(-5).map((e) => e.text).join(" ")}`;
}

export { getPage, pagesContaining, linksOf };
