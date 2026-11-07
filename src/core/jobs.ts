import { KNOBS } from "../knobs.js";
import { runEngine } from "./engine.js";
import { emptyDigest, fileConversation, fileSource, firstPagesGoal, writeDigestStep } from "./intake.js";
import { runReview } from "./mirror.js";
import { candidates, spotChecks, staleByIsaak, staleByTime, workStaleQueue } from "./upkeep.js";
import { checkpoint, registerJob, type Run } from "./queue.js";
import { addStream, getSource, getMeta, iso, json, listSources, setMeta } from "./store.js";
import { logStep, type RunCtx } from "./steps.js";
import { getPage, revisePage } from "./pages.js";
import { getRequest, listProposals } from "./workshop.js";
import { systemPrompt } from "./prompts.js";
import { extractJson } from "../json.js";
import { timed } from "./steps.js";

/** The jobs a run can do. Every job ends in the same engine or in upkeep and review, all recorded step by step. */

interface ReplyInput { message: string; streamId: string; sourceIds?: string[] }

/** Isaak spoke (with or without files): file the files first (receipt at once if big), then the run engine. */
async function reply(ctx: RunCtx, run: Run): Promise<void> {
  const input = run.input as unknown as ReplyInput;
  await logStep(ctx, { node: "you/send", kind: "event", label: `You: ${input.message}`.slice(0, 300) });
  await logStep(ctx, { node: "queue/tyou", kind: "event", label: "Your message jumps the queue" });
  await logStep(ctx, { node: "workshop/wnow", kind: "event", label: "Now: answering Isaak" });
  const digest = emptyDigest();
  const sources = [];
  for (const id of input.sourceIds ?? []) { const s = await getSource(ctx, id); if (s) sources.push(s); }
  if (sources.length) {
    await logStep(ctx, { node: "sources/files", kind: "event", label: `Kept whole: ${sources.map((s) => `"${s.title}" (${s.storedSize} of ${s.origSize} characters)`).join(", ")}`.slice(0, 300), lit: { sources: sources.map((s) => s.id) } });
    await logStep(ctx, { node: "sources/srcbrick", kind: "event", label: "A source brick for each file in the outer ring", lit: { sources: sources.map((s) => s.id) } });
    const total = sources.reduce((n, s) => n + s.body.length, 0);
    await logStep(ctx, { node: "intake/arrive", kind: "event", label: `Intake starts: ${sources.length} file(s), ${total} characters` });
    if (total > KNOBS.bigUploadReceiptChars) {
      const parts = Math.ceil(total / KNOBS.filingPartChars);
      await addStream(ctx, { kind: "its", content: `Got it: ${sources.map((s) => `"${s.title}"`).join(", ")}. Filing now, ${parts} part(s), about ${Math.max(1, Math.round((parts * 40) / 60))} minute(s); I'll answer when it's filed.`, runId: ctx.runId });
    }
    for (const s of sources) await fileSource(ctx, s, input.message || null, digest);
    await writeDigestStep(ctx, digest);
    await firstPagesGoal(ctx);
  }
  await retryFailedParts(ctx, digest, new Set(sources.map((s) => s.id)));
  await runEngine(ctx, run, { message: input.message || (sources.length ? `(sent ${sources.length} file(s) without a message)` : ""), purpose: "answer and act", digest: sources.length ? digest : null });
}

/** Parts that failed earlier (a refusal, a timeout) are retried on the next run. */
async function retryFailedParts(ctx: RunCtx, digest: ReturnType<typeof emptyDigest>, skip: Set<string>): Promise<void> {
  for (const s of await listSources(ctx, 200)) {
    if (skip.has(s.id) || !s.failedParts.length) continue;
    await logStep(ctx, { node: "intake/retry", kind: "event", label: `Retrying ${s.failedParts.length} failed part(s) of "${s.title}"` });
    await fileSource(ctx, s, null, digest, s.failedParts.map(Number));
  }
}

/** Its own time: a promise, a goal step, the first pages. */
async function own(ctx: RunCtx, run: Run): Promise<void> {
  await logStep(ctx, { node: "queue/tsched", kind: "event", label: `Its own time: ${run.purpose}`.slice(0, 300) });
  await logStep(ctx, { node: "workshop/wnow", kind: "event", label: `Now: ${run.purpose}`.slice(0, 300) });
  await checkpoint(ctx, () => ({ stage: "start" }));
  await runEngine(ctx, run, { purpose: run.purpose, extra: typeof run.input.extra === "string" ? run.input.extra : undefined });
}

/** The conversation, filed in one batch once Isaak has gone quiet. */
async function fileConversationJob(ctx: RunCtx): Promise<void> {
  const r = await ctx.db.query(`SELECT * FROM stream WHERE user_id=$1 AND filed_at IS NULL AND kind IN ('his','its') AND archived_at IS NULL ORDER BY at`, [ctx.userId]);
  const rows = r.rows.map((x) => ({ id: String(x.id), kind: String(x.kind) as "his" | "its", content: String(x.content), at: iso(x.at), sentWithSource: null, clientMsgId: null, runId: null, filedAt: null }));
  await fileConversation(ctx, rows);
}

/** Upkeep: dates passed, spot-checks, the stale queue (triage, rewrite), then the candidates code offers. */
async function upkeep(ctx: RunCtx, run: Run): Promise<void> {
  await logStep(ctx, { node: "queue/tupk", kind: "event", label: "Upkeep, within the background share" });
  const left = json<{ stage?: string }>(run.leftOff, {});
  if (!left.stage || left.stage === "routes") {
    await staleByTime(ctx);
    await spotChecks(ctx);
  }
  await workStaleQueue(ctx);
  await checkpoint(ctx, () => ({ stage: "candidates" }));
  const c = await candidates(ctx);
  const n = c.duplicates.length + c.islands.length + c.thinCentral.length + c.noPage.length;
  await logStep(ctx, { node: "upkeep/cands", kind: "event", label: `Candidates: ${c.duplicates.length} likely duplicate(s), ${c.islands.length} island(s), ${c.thinCentral.length} thin but central, ${c.noPage.length} cluster(s) with no page`, detail: c as unknown as Record<string, unknown> });
  const day = ctx.now().toISOString().slice(0, 10);
  if (n && (await getMeta(ctx, `bupk:${ctx.userId}`)) !== day) {
    await setMeta(ctx, `bupk:${ctx.userId}`, day);
    const extra = [
      c.duplicates.length ? `Likely duplicates:\n${c.duplicates.map((d) => `- [[b:${d.a}]] / [[b:${d.b}]]: ${d.why}`).join("\n")}` : "",
      c.islands.length ? `Islands (clusters linked to nothing else):\n${c.islands.map((i) => `- ${i.map((x) => `[[b:${x}]]`).join(" ")}`).join("\n")}` : "",
      c.thinCentral.length ? `Thin but central (high reach, little depth):\n${c.thinCentral.map((t) => `- [[b:${t.id}]] reach ${t.reach}, depth ${t.depth}`).join("\n")}` : "",
      c.noPage.length ? `Clusters with no page:\n${c.noPage.map((p) => `- ${p.map((x) => `[[b:${x}]]`).join(" ")}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    await logStep(ctx, { node: "upkeep/bupk", kind: "event", label: "Brick upkeep: it decides on each candidate" });
    await runEngine(ctx, run, { purpose: "Brick upkeep: decide on each candidate code offers (merge, split, relabel, link the newcomers, or write a page with its purpose). Open them first.", extra });
  }
}

async function review(ctx: RunCtx, run: Run): Promise<void> {
  await logStep(ctx, { node: "queue/trev", kind: "event", label: `The ${run.input.weekly ? "weekly look-back and daily" : "daily"} review is due` });
  await runReview(ctx, run);
}

/**
 * Isaak revised something: it may push back once, with evidence; then his word stands (BUILD_SPEC §5.12).
 * Pages get a new version; other targets get his words as an entry and a reply in the thread.
 */
async function revision(ctx: RunCtx, run: Run): Promise<void> {
  const { revisionId } = run.input as { revisionId: string };
  const r = (await ctx.db.query(`SELECT * FROM revisions WHERE user_id=$1 AND id=$2`, [ctx.userId, revisionId])).rows[0];
  if (!r) return;
  const kind = String(r.target_kind), target = String(r.target_id), his = String(r.his_text), pushedBack = r.pushed_back === true || r.pushed_back === "t";
  await logStep(ctx, { node: "you/revise", kind: "event", label: `You revised a ${kind}: ${his}`.slice(0, 300) });
  if (kind === "page") {
    const page = await getPage(ctx, target);
    if (!page) return;
    await staleByIsaak(ctx, target, his, revisionId);
    const system = await systemPrompt(ctx);
    const out = await timed(ctx, "you/discuss", "call", `Your revision of "${page.title}"`, () => ctx.ai.call({
      task: "revision", tier: "main", json: true, system,
      prompt: `TASK: revision\nIsaak revised a page of your memory. ${pushedBack ? "You already pushed back once; now his word stands: apply it." : "Apply it, or push back once if you have evidence he is wrong (cite it); after that his word stands."}\n\nPAGE [[p:${page.id}]] "${page.title}" (purpose: ${page.purpose})\n${page.body}\n\nHIS REVISION:\n${his}\n\nReturn JSON {"apply": true|false, "body": "the new body when applying", "change_note": "...", "reply": "one or two lines to him"}`,
    }), (x) => ({ model: x.model, charsIn: x.charsIn, charsOut: x.charsOut }));
    let v: { apply?: boolean; body?: string; change_note?: string; reply?: string } = {};
    try { v = extractJson(out.text) as typeof v; } catch { v = { apply: true }; }
    if (v.apply === false && !pushedBack) {
      await ctx.db.query(`UPDATE revisions SET status='discussing', its_reply=$3, pushed_back=true WHERE user_id=$1 AND id=$2`, [ctx.userId, revisionId, v.reply ?? ""]);
      await addStream(ctx, { kind: "its", content: `About your revision of "${page.title}": ${v.reply ?? ""}`, runId: ctx.runId });
      return;
    }
    const body = v.body || `${page.body}\n\n(Isaak, ${ctx.now().toISOString().slice(0, 10)}): ${his}`;
    const p = await revisePage(ctx, target, { body, changeNote: v.change_note || `Isaak's revision: ${his}`.slice(0, 300), claimChanged: true, reasonChain: [`isaak:${revisionId}`] }).catch(async () =>
      revisePage(ctx, target, { body: `${page.body}\n\n(Isaak, ${ctx.now().toISOString().slice(0, 10)}): ${his}`, changeNote: `Isaak's revision: ${his}`.slice(0, 300), claimChanged: true, reasonChain: [`isaak:${revisionId}`] }));
    await ctx.db.query(`UPDATE stale_marks SET done_at=$3, triage='yes', triage_why='Isaak revised it' WHERE user_id=$1 AND page_id=$2 AND done_at IS NULL AND route='isaak'`, [ctx.userId, target, ctx.now().toISOString()]);
    await ctx.db.query(`UPDATE revisions SET status='applied', its_reply=$3, applied_version=$4 WHERE user_id=$1 AND id=$2`, [ctx.userId, revisionId, v.reply ?? "", p.version]);
    await logStep(ctx, { node: "you/discuss", kind: "event", label: `Applied: "${page.title}" is now version ${p.version}`, lit: { pages: [target] } });
    return;
  }
  // bricks, guides-as-pages handled above; requests, bench items and everything else: his words are kept and answered by a run.
  await runEngine(ctx, run, { message: `I'm revising ${kind} ${target}: ${his}`, purpose: "answer a revision", extra: kind === "request" ? JSON.stringify(await getRequest(ctx, target)) : undefined });
  await ctx.db.query(`UPDATE revisions SET status='applied' WHERE user_id=$1 AND id=$2`, [ctx.userId, revisionId]);
}

/** A thread on a proposal: Isaak asked to discuss or revise it. */
async function discuss(ctx: RunCtx, run: Run): Promise<void> {
  const { proposalId, text } = run.input as { proposalId: string; text: string };
  const p = (await listProposals(ctx)).find((x) => x.id === proposalId);
  if (!p) return;
  const reqs = [];
  for (const id of p.requestIds) reqs.push(await getRequest(ctx, id));
  const out = await runEngine(ctx, run, { message: `About your proposal "${p.title}": ${text}`, purpose: "discuss a proposal", extra: `THE PROPOSAL\n${JSON.stringify({ ...p, requests: reqs }, null, 1).slice(0, 8000)}` });
  await ctx.db.query(`INSERT INTO revisions (id, user_id, target_kind, target_id, his_text, its_reply, status, created_at) VALUES ($1,$2,'proposal',$3,$4,$5,'discussing',$6)`,
    [run.id, ctx.userId, proposalId, text, out.reply, ctx.now().toISOString()]);
}

let registered = false;
export function registerJobs(): void {
  if (registered) return;
  registered = true;
  registerJob("reply", reply);
  registerJob("own", own);
  registerJob("file_conversation", fileConversationJob);
  registerJob("upkeep", upkeep);
  registerJob("review", review);
  registerJob("revision", revision);
  registerJob("discuss", discuss);
}
