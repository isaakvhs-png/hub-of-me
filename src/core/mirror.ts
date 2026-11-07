import { extractJson } from "../json.js";
import { KNOBS } from "../knobs.js";
import { SYSTEM_MAP } from "../self/map.js";
import { allowanceUsed } from "./ai.js";
import { find } from "./look.js";
import { auditFile, traceRun } from "./hands.js";
import { createPage, findPageByTitle, listPages, revisePage } from "./pages.js";
import { systemPrompt } from "./prompts.js";
import { checkpoint, enqueue, type Run } from "./queue.js";
import { addEntry, getBrick, iso, json, sid } from "./store.js";
import { logStep, timed, type Ctx, type RunCtx } from "./steps.js";
import { backlog, candidates } from "./upkeep.js";
import { addProposal, addRequestOrEvidence, getRequest, listRequests, putOnBench, updateRequest } from "./workshop.js";

/**
 * The mirror (BUILD_SPEC §5.9). Nightly (23:30, knob): code builds the day file from run_steps, packs, filing notes,
 * upkeep, Isaak's messages and reactions, requests and failures; code counts the signals; a different model from the
 * worker writes a review draft, then a typed action list; code applies it. One rotating deep check a night.
 * Sundays also look back over the week. Tomorrow's day file includes tonight's review.
 */

export interface Signals {
  period: { from: string; to: string };
  runs: { total: number; byJob: Record<string, number>; failed: number; avgMsByJob: Record<string, number>; callsPerRun: number };
  revisions: { total: number; byKind: Record<string, number> };
  reactions: { benchDone: number; benchDismissed: number; benchIgnored: number; proposalsYes: number; proposalsNo: number; proposalsOpen: number };
  questionsItsWebCouldAnswer: { count: number; examples: string[] };
  promises: { kept: number; late: number; broken: number; withoutRun: number };
  goalsStuck: number;
  failures: { steps: number; refusalsOrFallbacks: number; examples: string[] };
  packWaste: { packChars: number; usedChars: number; wasteShare: number | null };
  upkeep: { staleBacklog: number; triagedNo: number; triagedYes: number; spotChecksWrong: number; markedByRoute: Record<string, number> };
  filingCoverage: { source: string; title: string; quotedShare: number; failedParts: number; cutOff: boolean }[];
  web: { islands: number; duplicatesLikely: number; merges: number; bricks: number; pages: number };
  attention: Record<string, { opens: number; ms: number }>;
  allowanceUsed: number | null;
  heartbeatGaps: { from: string; to: string; minutes: number }[];
  server: { commit: string; latestKnown: string };
  messages: { his: number; its: number };
}

const count = async (ctx: Ctx, sql: string, params: unknown[]) => Number((await ctx.db.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);

/** Every signal is counted by code from the records; no model makes them up. */
export async function computeSignals(ctx: Ctx, from: Date, to: Date): Promise<Signals> {
  const p = [ctx.userId, from.toISOString(), to.toISOString()];
  const runs = (await ctx.db.query(`SELECT id, job, status, started_at, ended_at, due_at, why FROM runs WHERE user_id=$1 AND created_at >= $2 AND created_at < $3`, p)).rows;
  const byJob: Record<string, number> = {}; const msByJob: Record<string, number[]> = {};
  for (const r of runs) {
    byJob[String(r.job)] = (byJob[String(r.job)] ?? 0) + 1;
    if (r.started_at && r.ended_at) (msByJob[String(r.job)] ??= []).push(new Date(iso(r.ended_at)).getTime() - new Date(iso(r.started_at)).getTime());
  }
  const calls = await count(ctx, `SELECT count(*) AS n FROM run_steps WHERE user_id=$1 AND at >= $2 AND at < $3 AND kind='call'`, p);
  const revs = (await ctx.db.query(`SELECT target_kind FROM revisions WHERE user_id=$1 AND created_at >= $2 AND created_at < $3`, p)).rows;
  const byKind: Record<string, number> = {};
  for (const r of revs) byKind[String(r.target_kind)] = (byKind[String(r.target_kind)] ?? 0) + 1;
  const bench = (await ctx.db.query(`SELECT kind, title, status, created_at FROM bench WHERE user_id=$1 AND created_at < $3 AND origin='its'`, p)).rows;
  const inPeriod = bench.filter((b) => iso(b.created_at) >= p[1]);
  const ignored = bench.filter((b) => b.status === "open" && to.getTime() - new Date(iso(b.created_at)).getTime() > 3 * 86_400_000).length;
  const props = (await ctx.db.query(`SELECT status, his_decision FROM proposals WHERE user_id=$1`, [ctx.userId])).rows;
  // Questions its web could have answered: every question it put to Isaak, searched for in its own memory by code.
  const questions = inPeriod.filter((b) => b.kind === "question");
  const answerable: string[] = [];
  for (const q of questions) {
    const hits = (await find(ctx, String(q.title), 5)).filter((h) => (h.score ?? 0) >= 2 && h.kind !== "source");
    if (hits.length) answerable.push(`${q.title} → ${hits.map((h) => h.title).join(", ")}`);
  }
  // Promises: scheduled runs that came from a promise, kept / late / broken; and promises code had to back.
  const promiseRuns = (await ctx.db.query(`SELECT status, due_at, started_at FROM runs WHERE user_id=$1 AND trigger='schedule' AND due_at >= $2 AND due_at < $3`, p)).rows;
  let kept = 0, late = 0, broken = 0;
  for (const r of promiseRuns) {
    const due = new Date(iso(r.due_at)).getTime();
    if (r.status === "failed") broken += 1;
    else if (!r.started_at) { if (to.getTime() - due > 6 * 3600_000) broken += 1; }
    else if (new Date(iso(r.started_at)).getTime() - due > 3600_000) late += 1;
    else kept += 1;
  }
  const withoutRun = await count(ctx, `SELECT count(*) AS n FROM run_steps WHERE user_id=$1 AND at >= $2 AND at < $3 AND label LIKE 'A promise with nothing behind it%'`, p);
  const goalsStuck = (await ctx.db.query(`SELECT steps, created_at FROM goals WHERE user_id=$1 AND status='open' AND archived_at IS NULL`, [ctx.userId])).rows
    .filter((g) => { const steps = json<{ at: string }[]>(g.steps, []); const last = steps.length ? steps[steps.length - 1].at : iso(g.created_at); return to.getTime() - new Date(last).getTime() > 3 * 86_400_000; }).length;
  const failedSteps = (await ctx.db.query(`SELECT label, detail FROM run_steps WHERE user_id=$1 AND at >= $2 AND at < $3 AND ok=false ORDER BY at`, p)).rows;
  const fallbacks = (await ctx.db.query(`SELECT detail FROM run_steps WHERE user_id=$1 AND at >= $2 AND at < $3 AND kind='call' AND detail LIKE '%fellBack%'`, p)).rows.filter((r) => json<{ fellBack?: string }>(r.detail, {}).fellBack).length;
  const packs = (await ctx.db.query(`SELECT contents, used FROM packs WHERE user_id=$1 AND created_at >= $2 AND created_at < $3`, p)).rows;
  let packChars = 0, usedChars = 0;
  for (const pk of packs) {
    const used = new Set(json<string[]>(pk.used, []));
    for (const c of json<{ id: string; chars: number }[]>(pk.contents, [])) { packChars += c.chars ?? 0; if (used.has(c.id)) usedChars += c.chars ?? 0; }
  }
  const marks = (await ctx.db.query(`SELECT route, triage FROM stale_marks WHERE user_id=$1 AND at >= $2 AND at < $3`, p)).rows;
  const markedByRoute: Record<string, number> = {};
  for (const m of marks) markedByRoute[String(m.route)] = (markedByRoute[String(m.route)] ?? 0) + 1;
  const sources = (await ctx.db.query(`SELECT id, title, body, orig_size, stored_size, failed_parts FROM sources WHERE user_id=$1 AND archived_at IS NULL AND at >= $2 AND at < $3 AND kind IN ('file','his','contact','gemini')`, p)).rows;
  const coverage: Signals["filingCoverage"] = [];
  for (const s of sources) {
    const spans = (await ctx.db.query<{ char_start: number; char_end: number }>(`SELECT char_start, char_end FROM entries WHERE user_id=$1 AND source_id=$2 AND char_start IS NOT NULL`, [ctx.userId, s.id])).rows;
    const len = String(s.body).length;
    const covered = new Uint8Array(len);
    for (const sp of spans) for (let i = Number(sp.char_start); i < Math.min(Number(sp.char_end), len); i += 1) covered[i] = 1;
    coverage.push({ source: String(s.id), title: String(s.title), quotedShare: len ? Math.round((covered.reduce((a, b) => a + b, 0) / len) * 100) / 100 : 0, failedParts: json<string[]>(s.failed_parts, []).length, cutOff: Number(s.orig_size) > Number(s.stored_size) });
  }
  const c = await candidates(ctx);
  const merges = await count(ctx, `SELECT count(*) AS n FROM run_steps WHERE user_id=$1 AND at >= $2 AND at < $3 AND node='hands/hweb' AND label LIKE 'merge:%' AND ok=true`, p);
  const att: Signals["attention"] = {};
  for (const a of (await ctx.db.query(`SELECT what, ms FROM attention WHERE user_id=$1 AND at >= $2 AND at < $3`, p)).rows) { const k = String(a.what).split(":")[0]; (att[k] ??= { opens: 0, ms: 0 }).opens += 1; att[k].ms += Number(a.ms); }
  const beats = (await ctx.db.query(`SELECT at FROM heartbeat WHERE user_id=$1 AND at >= $2 AND at < $3 ORDER BY at`, p)).rows.map((r) => new Date(iso(r.at)).getTime());
  const gaps: Signals["heartbeatGaps"] = [];
  for (let i = 1; i < beats.length; i += 1) if (beats[i] - beats[i - 1] > 3 * 60_000) gaps.push({ from: new Date(beats[i - 1]).toISOString(), to: new Date(beats[i]).toISOString(), minutes: Math.round((beats[i] - beats[i - 1]) / 60_000) });
  const msgs = (await ctx.db.query(`SELECT kind, count(*) AS n FROM stream WHERE user_id=$1 AND at >= $2 AND at < $3 GROUP BY kind`, p)).rows;
  return {
    period: { from: p[1] as string, to: p[2] as string },
    runs: { total: runs.length, byJob, failed: runs.filter((r) => r.status === "failed").length, avgMsByJob: Object.fromEntries(Object.entries(msByJob).map(([k, v]) => [k, Math.round(v.reduce((a, b) => a + b, 0) / v.length)])), callsPerRun: runs.length ? Math.round((calls / runs.length) * 10) / 10 : 0 },
    revisions: { total: revs.length, byKind },
    reactions: { benchDone: inPeriod.filter((b) => b.status === "done" || b.status === "used").length, benchDismissed: inPeriod.filter((b) => b.status === "dismissed").length, benchIgnored: ignored, proposalsYes: props.filter((x) => x.his_decision === "yes").length, proposalsNo: props.filter((x) => x.his_decision === "no").length, proposalsOpen: props.filter((x) => x.status === "ready").length },
    questionsItsWebCouldAnswer: { count: answerable.length, examples: answerable.slice(0, 5) },
    promises: { kept, late, broken, withoutRun },
    goalsStuck,
    failures: { steps: failedSteps.length, refusalsOrFallbacks: fallbacks + failedSteps.filter((f) => /refus/i.test(String(f.label) + String(f.detail))).length, examples: failedSteps.slice(0, 8).map((f) => String(f.label)) },
    packWaste: { packChars, usedChars, wasteShare: packChars ? Math.round((1 - usedChars / packChars) * 100) / 100 : null },
    upkeep: { staleBacklog: await backlog(ctx), triagedNo: marks.filter((m) => m.triage === "no").length, triagedYes: marks.filter((m) => m.triage === "yes").length, spotChecksWrong: marks.filter((m) => m.route === "spotcheck" && m.triage === "yes").length, markedByRoute },
    filingCoverage: coverage,
    web: { islands: c.islands.length, duplicatesLikely: c.duplicates.length, merges, bricks: await count(ctx, `SELECT count(*) AS n FROM bricks WHERE user_id=$1 AND archived_at IS NULL`, [ctx.userId]), pages: (await listPages(ctx)).length },
    attention: att,
    allowanceUsed: allowanceUsed(),
    heartbeatGaps: gaps,
    server: { commit: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? "unknown", latestKnown: "unknown: checking the latest commit needs a GitHub read token (a request it can make)" },
    messages: { his: Number(msgs.find((m) => m.kind === "his")?.n ?? 0), its: Number(msgs.find((m) => m.kind === "its")?.n ?? 0) },
  };
}

/** The whole day, structured: runs (why, pack and use, drafts, acts, time), filing, upkeep, his messages and reactions, requests, failures. */
export async function dayFile(ctx: Ctx, from: Date, to: Date): Promise<string> {
  const p = [ctx.userId, from.toISOString(), to.toISOString()];
  const runs = (await ctx.db.query(`SELECT * FROM runs WHERE user_id=$1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at`, p)).rows;
  const lines: string[] = [`DAY FILE ${from.toISOString().slice(0, 16)} → ${to.toISOString().slice(0, 16)}`];
  for (const r of runs) {
    const steps = (await ctx.db.query(`SELECT node, kind, label, model, ms, ok FROM run_steps WHERE user_id=$1 AND run_id=$2 ORDER BY seq`, [ctx.userId, r.id])).rows;
    const pack = (await ctx.db.query(`SELECT contents, used FROM packs WHERE user_id=$1 AND run_id=$2`, [ctx.userId, r.id])).rows[0];
    const contents = json<{ kind: string; id: string; chars: number }[]>(pack?.contents, []);
    const used = json<string[]>(pack?.used, []);
    lines.push(`\n## Run ${r.id} (${r.trigger}/${r.job}, ${r.status}) ${String(r.purpose).slice(0, 200)}${r.error ? `\nERROR: ${String(r.error).slice(0, 300)}` : ""}`);
    if (pack) lines.push(`Pack: ${contents.length} items, ${contents.reduce((n, c) => n + (c.chars ?? 0), 0)} chars; used ${used.length}.`);
    for (const s of steps) lines.push(`- ${s.ok ? "" : "FAILED "}${s.node} [${s.kind}${s.model ? ` ${s.model}` : ""}, ${s.ms} ms] ${String(s.label).slice(0, 240)}`);
  }
  const his = (await ctx.db.query(`SELECT kind, content, at FROM stream WHERE user_id=$1 AND at >= $2 AND at < $3 ORDER BY at`, p)).rows;
  lines.push(`\n## The conversation (${his.length} messages)`);
  for (const m of his) lines.push(`${m.kind === "his" ? "ISAAK" : m.kind === "its" ? "YOU" : "SYSTEM"} ${iso(m.at).slice(11, 16)}: ${String(m.content).slice(0, 600)}`);
  const reactions = (await ctx.db.query(`SELECT kind, title, status, his_note FROM bench WHERE user_id=$1 AND (created_at >= $2 OR status <> 'open') AND created_at < $3 ORDER BY created_at`, p)).rows;
  lines.push(`\n## The bench (what it put before Isaak, and what he did)`);
  for (const b of reactions) lines.push(`- ${b.kind}: ${b.title} → ${b.status}${b.his_note ? ` (${b.his_note})` : ""}`);
  const revs = (await ctx.db.query(`SELECT target_kind, his_text, its_reply, status FROM revisions WHERE user_id=$1 AND created_at >= $2 AND created_at < $3`, p)).rows;
  if (revs.length) { lines.push(`\n## Isaak's revisions`); for (const r of revs) lines.push(`- ${r.target_kind}: "${r.his_text}" → ${r.status}${r.its_reply ? ` (it said: ${r.its_reply})` : ""}`); }
  const reqs = (await ctx.db.query(`SELECT id, title, status, evidence_count, his_decision, his_why FROM requests WHERE user_id=$1 AND updated_at >= $2`, [ctx.userId, from.toISOString()])).rows;
  lines.push(`\n## Requests touched`);
  for (const r of reqs) lines.push(`- ${r.id} "${r.title}" ${r.status}, ${r.evidence_count} run(s)${r.his_decision ? `, Isaak: ${r.his_decision} ${r.his_why}` : ""}`);
  const live = (await listRequests(ctx)).filter((r) => r.status === "live" && r.liveAt && to.getTime() - new Date(r.liveAt).getTime() >= 7 * 86_400_000);
  if (live.length) { lines.push(`\n## Live changes a week or more old: check each against its prediction`); for (const r of live) lines.push(`- ${r.id} "${r.title}": prediction "${r.prediction}", live since ${r.liveAt}`); }
  const last = (await ctx.db.query(`SELECT body FROM reports WHERE user_id=$1 AND scale='day' ORDER BY created_at DESC LIMIT 1`, [ctx.userId])).rows[0];
  if (last) lines.push(`\n## Yesterday's review (the review is reviewed too)\n${String(last.body).slice(0, 4000)}`);
  return lines.join("\n");
}

const DEEP_CHECKS = ["filing coverage", "link quality", "gathering", "triage 'no' answers", "page drift", "promises", "requests", "its own notes on his bricks", "the corners", "self-guides hardening into rules"] as const;

/** One rotating deep check a night, so every area is examined at least every two weeks. Code prepares the material. */
export async function deepCheck(ctx: RunCtx, day: Date): Promise<{ area: string; material: string }> {
  const area = DEEP_CHECKS[Math.floor(day.getTime() / 86_400_000) % DEEP_CHECKS.length];
  let material = "";
  if (area === "filing coverage") {
    const s = (await ctx.db.query<{ id: string }>(`SELECT id FROM sources WHERE user_id=$1 AND archived_at IS NULL AND kind='file' ORDER BY random() LIMIT 1`, [ctx.userId])).rows[0];
    material = s ? await auditFile(ctx, s.id) : "No files yet.";
  } else if (area === "link quality") {
    const links = (await ctx.db.query(`SELECT a, b, relation, reason, made_by FROM links WHERE user_id=$1 AND archived_at IS NULL ORDER BY random() LIMIT 12`, [ctx.userId])).rows;
    const out: string[] = [];
    for (const l of links) out.push(`- ${(await getBrick(ctx, String(l.a)))?.name ?? l.a} —${l.relation}→ ${(await getBrick(ctx, String(l.b)))?.name ?? l.b}: ${l.reason} (by ${l.made_by})`);
    const dist = (await ctx.db.query(`SELECT n, count(*) AS bricks FROM (SELECT b.id, (SELECT count(*) FROM links l WHERE l.user_id=b.user_id AND (l.a=b.id OR l.b=b.id) AND l.archived_at IS NULL) AS n FROM bricks b WHERE b.user_id=$1 AND b.archived_at IS NULL) t GROUP BY n ORDER BY n`, [ctx.userId])).rows;
    material = `A sample of links:\n${out.join("\n") || "none"}\nLinks per brick (links: bricks): ${dist.map((d) => `${d.n}: ${d.bricks}`).join(", ")}`;
  } else if (area === "gathering") {
    const r = (await ctx.db.query<{ id: string }>(`SELECT r.id FROM runs r WHERE r.user_id=$1 AND r.job='reply' AND r.status='done' ORDER BY (SELECT count(*) FROM revisions v WHERE v.user_id=r.user_id AND v.created_at > r.created_at) DESC, r.created_at DESC LIMIT 1`, [ctx.userId])).rows[0];
    material = r ? await traceRun(ctx, r.id) : "No reply runs yet.";
  } else if (area === "triage 'no' answers") {
    const rows = (await ctx.db.query(`SELECT m.reason, m.triage_why, p.title FROM stale_marks m JOIN pages p ON p.id=m.page_id WHERE m.user_id=$1 AND m.triage='no' ORDER BY random() LIMIT 6`, [ctx.userId])).rows;
    material = rows.map((r) => `- "${r.title}": marked because ${r.reason}; triage said no: ${r.triage_why}`).join("\n") || "No 'no' answers yet.";
  } else if (area === "page drift") {
    const page = (await ctx.db.query(`SELECT id, title FROM pages WHERE user_id=$1 AND archived_at IS NULL AND version > 1 ORDER BY random() LIMIT 1`, [ctx.userId])).rows[0];
    if (page) {
      const versions = (await ctx.db.query(`SELECT version, change_note, claim_changed, left(body, 1500) AS body FROM page_versions WHERE user_id=$1 AND page_id=$2 ORDER BY version`, [ctx.userId, page.id])).rows;
      material = `"${page.title}" across its versions:\n${versions.map((v) => `v${v.version} (${v.claim_changed ? "claim changed" : "no claim changed"}: ${v.change_note})\n${v.body}`).join("\n---\n")}`;
    } else material = "No page has more than one version yet.";
  } else if (area === "promises") {
    const rows = (await ctx.db.query(`SELECT purpose, due_at, started_at, status FROM runs WHERE user_id=$1 AND trigger='schedule' ORDER BY due_at DESC LIMIT 15`, [ctx.userId])).rows;
    material = rows.map((r) => `- due ${iso(r.due_at).slice(0, 16)}, ${r.status}${r.started_at ? `, started ${iso(r.started_at).slice(0, 16)}` : ""}: ${r.purpose}`).join("\n") || "No scheduled runs yet.";
  } else if (area === "requests") {
    material = (await listRequests(ctx)).map((r) => `- ${r.id} "${r.title}" ${r.status}, ${r.evidenceCount} run(s), since ${r.createdAt.slice(0, 10)}${r.hisDecision ? `, Isaak: ${r.hisDecision} (${r.hisWhy})` : ""}`).join("\n") || "No requests yet.";
  } else if (area === "its own notes on his bricks") {
    const rows = (await ctx.db.query(`SELECT b.name, e.kind, e.text FROM entries e JOIN bricks b ON b.id=e.brick_id WHERE e.user_id=$1 AND e.origin='own' AND b.corner='his' AND e.archived_at IS NULL ORDER BY random() LIMIT 12`, [ctx.userId])).rows;
    material = `Entries of its own origin on bricks about Isaak's life (should be labelled, never read as evidence about him):\n${rows.map((r) => `- ${r.name}: (${r.kind}) ${r.text}`).join("\n") || "none"}`;
  } else if (area === "the corners") {
    const rows = (await ctx.db.query(`SELECT name, corner, summary FROM bricks WHERE user_id=$1 AND archived_at IS NULL AND kind<>'source' AND (name ILIKE '%hub of me%' OR name ILIKE '%yourself%' OR summary ILIKE '%how you work%' OR corner='own') LIMIT 30`, [ctx.userId])).rows;
    material = `Bricks that look like they are about itself, with their corner (questions about itself belong in its own corner, never in his life):\n${rows.map((r) => `- ${r.name} [${r.corner}]: ${r.summary}`).join("\n") || "none"}`;
  } else {
    const guides = await listPages(ctx, "guide");
    material = guides.map((g) => `"${g.title}" v${g.version}:\n${g.body}`).join("\n\n") || "No self-guides yet.";
  }
  await logStep(ctx, { node: "review/daily/dayfile", kind: "event", label: `Tonight's deep check: ${area}`, charsOut: material.length });
  return { area, material };
}

interface Action { type?: string; [k: string]: unknown }
const s = (v: unknown) => (v == null ? "" : String(v));

/** Code carries out each typed action, and records the result. */
async function applyAction(ctx: RunCtx, a: Action): Promise<string> {
  switch (a.type) {
    case "request":
    case "change_request": {
      const files = Array.isArray(a.files) ? (a.files as string[]).join(", ") : "";
      const { request, isNew } = await addRequestOrEvidence(ctx, { title: s(a.title), kind: a.type === "change_request" ? "change" : s(a.kind) || "hand", problem: s(a.problem), proposal: `${s(a.proposal)}${files ? `\nFiles: ${files}` : ""}`, prediction: s(a.prediction), unblocks: a.unblocks as string[] | undefined, target: s(a.target) || "self" });
      return `${isNew ? "opened" : "evidence on"} ${request.id}`;
    }
    case "guide_revision": {
      const title = s(a.guide) || "How I work with Isaak";
      const body = `${s(a.body)}`;
      const existing = await findPageByTitle(ctx, title);
      if (KNOBS.guidesNeedHisYes) {
        await putOnBench(ctx, { kind: "suggestion", title: `A change to my guide "${title}"`, body: `${s(a.change_note)}\n\n${body}\n\nEvidence: ${s(a.evidence)}` });
        return "proposed to Isaak (guides need his yes)";
      }
      const page = existing ? await revisePage(ctx, existing.id, { body, changeNote: `${s(a.change_note)} Evidence: ${s(a.evidence)}`.slice(0, 500), claimChanged: true }) : await createPage(ctx, { kind: "guide", title, purpose: `How I ${title.replace(/^How I /i, "")}: my own working notes, each line with its evidence`, body });
      await logStep(ctx, { node: "web/guides", kind: "event", label: `Self-guide "${title}" ${existing ? "revised" : "started"}, with evidence`, lit: { pages: [page.id] } });
      return `guide ${page.id} v${page.version}`;
    }
    case "upkeep_job": {
      const run = await enqueue(ctx, { trigger: "upkeep", job: "own", purpose: s(a.purpose), why: "from the nightly review" });
      return `queued ${run.id}`;
    }
    case "bench_question": {
      const item = await putOnBench(ctx, { kind: "question", title: s(a.title), body: s(a.body) });
      return `bench ${item.id}`;
    }
    case "merge_requests": {
      const drop = Array.isArray(a.drop) ? (a.drop as string[]) : [s(a.drop)];
      for (const d of drop) await updateRequest(ctx, d, { status: "merged", mergedInto: s(a.keep) });
      return `merged ${drop.join(", ")} into ${s(a.keep)}`;
    }
    case "drop_request": {
      await updateRequest(ctx, s(a.id), { status: "dropped", hisWhy: `review: ${s(a.why)}` });
      return `dropped ${s(a.id)}`;
    }
    case "rank": {
      const ids = Array.isArray(a.ids) ? (a.ids as string[]) : [];
      for (let i = 0; i < ids.length; i += 1) await ctx.db.query(`UPDATE requests SET spec = $3 WHERE user_id=$1 AND id=$2`, [ctx.userId, ids[i], JSON.stringify({ ...((await getRequest(ctx, ids[i]))?.spec ?? {}), rank: i + 1 })]);
      return `ranked ${ids.length}`;
    }
    case "bundle_proposal": {
      const ids = (Array.isArray(a.request_ids) ? (a.request_ids as string[]) : []).filter(Boolean);
      const p = await addProposal(ctx, { title: s(a.title), why: s(a.why), requestIds: ids, target: s(a.target) || "self", spec: s(a.spec), prediction: s(a.prediction), cost: s(a.cost) });
      await logStep(ctx, { node: "workshop/wprops", kind: "event", label: `Proposal ready in the workshop: ${p.title}`.slice(0, 300) });
      return `proposal ${p.id}`;
    }
    case "verify": {
      const verdict = s(a.verdict) === "reopened" ? "reopened" : "verified";
      await updateRequest(ctx, s(a.request_id), { status: verdict === "verified" ? "verified" : "open" });
      await logStep(ctx, { node: verdict === "verified" ? "requests/rver" : "review/causes/clive", kind: "event", label: `${verdict}: ${s(a.request_id)} — ${s(a.why)}`.slice(0, 300) });
      return verdict;
    }
    case "track_record": {
      const line = `- ${ctx.now().toISOString().slice(0, 10)}: ${s(a.line)}`;
      const page = (await listPages(ctx, "track"))[0];
      const p = page ? await revisePage(ctx, page.id, { body: `${page.body}\n${line}`, changeNote: "a new line from the nightly review", claimChanged: false }) : await createPage(ctx, { kind: "track", title: "Track record", purpose: "Which kinds of fixes helped and which didn't; read by reviews before they propose.", body: `# Track record\n${line}` });
      await logStep(ctx, { node: "review/layers/l4", kind: "event", label: `Track record: ${s(a.line)}`.slice(0, 300), lit: { pages: [p.id] } });
      return `track ${p.id}`;
    }
    case "entry": {
      const b = await getBrick(ctx, s(a.brick_id));
      if (!b) return "no such brick";
      await addEntry(ctx, { brickId: b.id, kind: s(a.kind) || "result", text: s(a.text), origin: "own" });
      return `entry on ${b.id}`;
    }
    case "page": {
      const existing = await findPageByTitle(ctx, s(a.title));
      const p = existing ? await revisePage(ctx, existing.id, { body: s(a.body), changeNote: "from the nightly review", claimChanged: true }) : await createPage(ctx, { kind: (s(a.kind) as "page") || "page", title: s(a.title), purpose: s(a.purpose), body: s(a.body) });
      return `page ${p.id} v${p.version}`;
    }
    default:
      return `unknown action type ${s(a.type)}`;
  }
}

/** The nightly review run: day file → signals → deep check → review draft (another model) → action list → applied. */
export async function runReview(ctx: RunCtx, run: Run): Promise<void> {
  const to = ctx.now();
  const from = new Date(to.getTime() - 24 * 3600_000);
  const weekly = Boolean(run.input.weekly);
  const day = await timed(ctx, "review/daily/recs", "event", "Today's run records", () => dayFile(ctx, from, to), (t) => ({ charsOut: t.length }));
  await logStep(ctx, { node: "review/daily/dayfile", kind: "event", label: `The day file: ${day.length} characters`, charsOut: day.length });
  const signals = await timed(ctx, "review/daily/signals", "event", "Signals, counted by code", () => computeSignals(ctx, from, to), (sg) => ({ detail: sg as unknown as Record<string, unknown>, label: `Signals: ${sg.runs.total} runs, ${sg.questionsItsWebCouldAnswer.count} question(s) its web could answer, promises ${sg.promises.kept}/${sg.promises.late}/${sg.promises.broken}, pack waste ${sg.packWaste.wasteShare == null ? "n/a" : `${Math.round(sg.packWaste.wasteShare * 100)}%`}` }));
  const deep = await deepCheck(ctx, to);
  const track = (await listPages(ctx, "track"))[0];
  let weekText = "";
  if (weekly) {
    const reports = (await ctx.db.query(`SELECT period, body, signals FROM reports WHERE user_id=$1 AND scale='day' ORDER BY created_at DESC LIMIT 7`, [ctx.userId])).rows;
    const trend = [];
    for (let i = 6; i >= 0; i -= 1) {
      const end = new Date(to.getTime() - i * 86_400_000);
      const sg = await computeSignals(ctx, new Date(end.getTime() - 86_400_000), end);
      trend.push(`${end.toISOString().slice(0, 10)}: runs ${sg.runs.total}, failures ${sg.failures.steps}, pack waste ${sg.packWaste.wasteShare ?? "n/a"}, backlog ${sg.upkeep.staleBacklog}, answerable questions ${sg.questionsItsWebCouldAnswer.count}, promises kept/late/broken ${sg.promises.kept}/${sg.promises.late}/${sg.promises.broken}`);
    }
    const handUse = (await ctx.db.query(`SELECT label FROM run_steps WHERE user_id=$1 AND at >= $2 AND kind='act'`, [ctx.userId, new Date(to.getTime() - 7 * 86_400_000).toISOString()])).rows;
    const uses: Record<string, number> = {};
    for (const h of handUse) { const n = String(h.label).split(/[: ]/)[0]; uses[n] = (uses[n] ?? 0) + 1; }
    weekText = `\n\n=== THE WEEK (Sunday look-back) ===\nThe last seven daily reports:\n${reports.map((r) => `--- ${r.period}\n${String(r.body).slice(0, 2500)}`).join("\n")}\n\nSignal trends:\n${trend.join("\n")}\n\nHand use this week: ${JSON.stringify(uses)}\n\nYour code map (the twelve parts): ${Object.entries(SYSTEM_MAP.kids ?? {}).map(([k, v]) => `${k}: ${v.t} (${v.s})`).join("; ")}\nIs your structure right? Look for structural proposals, including things Isaak never asked about.`;
  }
  await checkpoint(ctx, () => ({ stage: "draft" }));
  const system = await systemPrompt(ctx);
  const draft = await timed(ctx, "review/daily/rdraft", "call", "Review draft (a different model from the worker)", () => ctx.ai.call({
    task: "review-draft", tier: "review", system,
    prompt: `TASK: review-draft\nYou review a day of your own work (written by ${ctx.ai.modelFor("main")}; you are ${ctx.ai.modelFor("review")}). Lean on the facts in the records and the signals code counted; nothing else.\nWrite plain text: what you tried, what worked, what didn't, and for each problem its kind of cause: a hand you lack; your code holds you back (name files); your own judgment (a self-guide to revise, with evidence); the shape of your memory (an upkeep job); unclear from Isaak (a question); a change that went live (verified or reopened, against its prediction). Every fix you propose carries a prediction (which signal should move, from what to what). Read the track record before proposing: which kinds of fixes worked.\n\nSIGNALS\n${JSON.stringify(signals, null, 1)}\n\nTONIGHT'S DEEP CHECK: ${deep.area}\n${deep.material}\n\nTRACK RECORD\n${track?.body ?? "(none yet)"}\n\n${day}${weekText}`,
  }), (r) => ({ model: r.model, charsIn: r.charsIn, charsOut: r.charsOut, detail: { fellBack: r.fellBack } }));
  await checkpoint(ctx, () => ({ stage: "actions", draft: draft.text.slice(0, 20000) }));
  const open = await listRequests(ctx, { open: true });
  const actions = await timed(ctx, "review/daily/actions", "call", "The action list", () => ctx.ai.call({
    task: "review-actions", tier: "review", json: true, system,
    prompt: `TASK: review-actions\nTurn your review into typed actions that code can carry out. Types:
request {title, kind, problem, proposal, prediction, unblocks?, target?}; change_request {title, files[], problem, proposal, prediction};
guide_revision {guide ("How I file"|"How I gather"|"How I work with Isaak"|"How I present things"|…), body (the whole new guide, each line with its evidence), change_note, evidence};
upkeep_job {purpose}; bench_question {title, body}; merge_requests {keep, drop[], why}; drop_request {id, why} (check first: can an existing hand already do this?);
rank {ids[]} (enabling requests first); bundle_proposal {title, why, request_ids[], spec, prediction, cost} (ready requests only); verify {request_id, verdict: verified|reopened, why};
track_record {line}; entry {brick_id, kind, text}; page {title, purpose, body, kind?}.
Open requests: ${open.map((r) => `${r.id} "${r.title}" (${r.status}, ${r.evidenceCount} runs${r.unblocks.length ? `, unblocks ${r.unblocks.join("; ")}` : ""})`).join("; ") || "none"}.
Return JSON {"actions":[...], "report":"a short report for Isaak, plain words: what happened today, what you changed, what needs him"}

YOUR REVIEW DRAFT
${draft.text}`,
  }), (r) => ({ model: r.model, charsIn: r.charsIn, charsOut: r.charsOut }));
  let parsed: { actions?: Action[]; report?: string } = {};
  try { parsed = extractJson(actions.text) as typeof parsed; } catch { parsed = { actions: [], report: draft.text.slice(0, 3000) }; await logStep(ctx, { node: "review/daily/actions", kind: "event", label: "The action list was not JSON: no actions applied tonight", ok: false }); }
  const reportId = sid();
  const period = to.toISOString().slice(0, 10);
  await ctx.db.query(`INSERT INTO reports (id, user_id, scale, period, body, signals, run_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [reportId, ctx.userId, weekly ? "week" : "day", period, `${parsed.report ?? ""}\n\n---\n${draft.text}`, JSON.stringify(signals), ctx.runId, ctx.now().toISOString()]);
  const results: string[] = [];
  for (const a of (parsed.actions ?? []).slice(0, 40)) {
    let result: string;
    try { result = await applyAction(ctx, a); } catch (error) { result = `failed: ${(error as Error).message}`; }
    results.push(`${a.type}: ${result}`);
    await ctx.db.query(`INSERT INTO review_actions (id, user_id, report_id, type, payload, applied, result, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [sid(), ctx.userId, reportId, s(a.type), JSON.stringify(a), !result.startsWith("failed"), result, ctx.now().toISOString()]);
  }
  await logStep(ctx, { node: "review/daily/apply", kind: "event", label: `Applied by code: ${results.length} action(s)`, detail: { results } });
  await putOnBench(ctx, { kind: "report", title: `${weekly ? "This week's" : "Tonight's"} review (${period})`, body: parsed.report ?? draft.text.slice(0, 3000), refs: { reportId } });
  await logStep(ctx, { node: "workshop/wrep", kind: "event", label: `Report in the workshop: ${(parsed.report ?? "").slice(0, 200)}` });
  if (weekly) await logStep(ctx, { node: "review/weekly", kind: "event", label: "The weekly look-back is in the same report" });
}
