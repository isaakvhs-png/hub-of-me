import { extractJson } from "../json.js";
import { KNOBS } from "../knobs.js";
import { mapPaths, SYSTEM_MAP } from "../self/map.js";
import { emit } from "./bus.js";
import { act, explainPaths, readCode } from "./hands.js";
import { digestText, type Digest } from "./intake.js";
import { find, near, render, similar, web, type Ref } from "./look.js";
import { citations, lifeDocument, listPages, openingAndHeadings, themes, touchPages } from "./pages.js";
import { systemPrompt } from "./prompts.js";
import { addSource, addStream, listBricks, recentConversation, touchBricks, sid, type Brick } from "./store.js";
import { logStep, timed, type RunCtx } from "./steps.js";
import { addRequestOrEvidence, putOnBench, stepGoal, type BenchKind } from "./workshop.js";
import type { Run } from "./queue.js";
import type { Tier } from "./ai.js";

/**
 * A run (BUILD_SPEC §5.6): one engine for everything, whatever started it.
 * 1 starter (code) → 2 gather call (fast) → fetch at once → context pack → 3 call A (draft, then the reply, streamed;
 * may say OPEN: once) → 4 grading (from call A's tail, else call B) → 5 acts through hands → 6 everything recorded.
 */

export interface RunInput {
  /** Isaak's message, when he started it. */
  message?: string;
  /** What this run is for (own time, a promise, a goal step, an upkeep job). */
  purpose: string;
  digest?: Digest | null;
  /** Extra material code hands this run (candidates for brick upkeep, a revision, a proposal thread). */
  extra?: string;
}

export interface Starter { text: string; named: Brick[]; lifeId: string | null; summary: string }

const MAP_PATHS = new Set(mapPaths());

/** Bricks his words name (whole-word, names of 4+ characters). */
export function namedBricks(text: string, bricks: Brick[]): Brick[] {
  const lower = ` ${text.toLowerCase()} `;
  return bricks
    .filter((b) => b.kind !== "source" && b.name.length >= 4)
    .filter((b) => new RegExp(`[^\\p{L}\\p{N}]${b.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\p{L}\\p{N}]`, "u").test(lower))
    .slice(0, 10);
}

/** 1. The starter (code): life document, self-guides, the conversation so far, what was just filed, bricks named. */
export async function starter(ctx: RunCtx, input: RunInput): Promise<Starter> {
  return timed(ctx, "run/starter", "event", "Starter: life document, self-guides, the conversation, what was just filed, bricks named", async () => {
    const life = await lifeDocument(ctx);
    const lifeText = !life ? "(There is no life document yet. You write it once there are pages to build it from.)"
      : life.body.length <= KNOBS.lifeDocWholeUnderChars ? `[[p:${life.id}]] ${life.title}\n${life.body}` : `[[p:${life.id}]] ${life.title} (long: its opening and headings)\n${openingAndHeadings(life.body)}`;
    const guides = await listPages(ctx, "guide");
    const guidesText = guides.length ? guides.map((g) => `[[p:${g.id}]] ${g.title} (v${g.version})\n${g.body || "(empty so far)"}`).join("\n\n").slice(0, 15_000) : "(No self-guides yet: you write them as you learn: How I file, How I gather, How I work with Isaak, How I present things.)";
    const conversation = (await recentConversation(ctx, 8000)).map((r) => `${r.kind === "his" ? "ISAAK" : "YOU"} (${r.at.slice(0, 16)}): ${r.content}`).join("\n");
    const named = input.message ? namedBricks(input.message, await listBricks(ctx)) : [];
    const namedText = (await Promise.all(named.map((b) => render(ctx, { kind: "brick", id: b.id })))).join("\n\n").slice(0, 10_000);
    const digest = input.digest ? digestText(input.digest) : "";
    const text = [
      `## The life document\n${lifeText}`,
      `## Your self-guides\n${guidesText}`,
      `## The conversation so far\n${conversation || "(nothing yet)"}`,
      digest ? `## Just filed (intake digest)\n${digest}` : "",
      namedText ? `## Bricks his words name\n${namedText}` : "",
    ].filter(Boolean).join("\n\n");
    const th = await themes(ctx);
    const summary = [
      `Life document: ${life ? `[[p:${life.id}]] (${life.body.length} chars)` : "none yet"}.`,
      `Themes: ${th.map((t) => `[[p:${t.id}]] ${t.title}`).join("; ") || "none yet"}.`,
      `Self-guides: ${guides.map((g) => g.title).join(", ") || "none yet"}.`,
      named.length ? `Bricks his words name: ${named.map((b) => `[[b:${b.id}]] ${b.name}`).join("; ")}.` : "",
      digest ? `Just filed:\n${digest}` : "",
      `Recent conversation:\n${conversation.slice(-3000)}`,
    ].filter(Boolean).join("\n");
    return { text, named, lifeId: life?.id ?? null, summary };
  }, (s) => ({ charsOut: s.text.length, lit: { life: Boolean(s.lifeId), bricks: s.named.map((b) => b.id) } }));
}

interface Look { how: "find" | "similar" | "near" | "open" | "web"; what: string; why?: string }

/** 2. The gather call (fast model): what do I need to look at, and why? Then code fetches everything at once. */
export async function gather(ctx: RunCtx, st: Starter, input: RunInput, system: string, extraAsk?: string): Promise<{ refs: Ref[]; tier: Tier; plan: Look[] }> {
  const ask = input.message ? `ISAAK'S MESSAGE:\n${input.message}` : `YOUR OWN TIME. Purpose: ${input.purpose}`;
  const plan = await timed(ctx, "run/gather/gplan", "call", extraAsk ? `Gather once more: ${extraAsk}` : "Gather call: what do I need to look at?", () => ctx.ai.call({
    task: "gather", tier: "fast", json: true, system,
    prompt: `TASK: gather
What do you need to look at to do this well? Your own memory first; the internet only when the answer lives outside it.
Choose any of: find (words), similar (meaning), near (what is linked to an id), open (an id in full: a brick, page or source; or map:<path> for a part of yourself, or code:<file> for your own code), web (the internet; never private details).
Also choose the model for the draft: "main" (normal) or "deep" (hard thinking: strategy, a tangle of evidence, a design question about yourself).

WHAT YOU ALREADY SEE (the starter, in short):
${st.summary}

${ask}
${extraAsk ? `\nYOUR DRAFT SAID IT STILL NEEDS: ${extraAsk}\n` : ""}${input.extra ? `\nMATERIAL CODE HANDED THIS RUN:\n${input.extra.slice(0, 6000)}\n` : ""}
Parts of yourself you can open: ${Object.keys(SYSTEM_MAP.kids ?? {}).map((k) => `map:${k}`).join(", ")} (and their sub-paths).

Return JSON {"looks":[{"how":"find|similar|near|open|web","what":"...","why":"..."}],"model":"main|deep","why_model":"..."}`,
  }), (r) => ({ model: r.model, charsIn: r.charsIn, charsOut: r.charsOut, detail: { answer: r.text.slice(0, 3000) } }));
  let parsed: { looks?: Look[]; model?: string } = {};
  try { parsed = extractJson(plan.text) as typeof parsed; } catch { parsed = { looks: input.message ? [{ how: "find", what: input.message.slice(0, 200), why: "the gather answer was not JSON; fell back to a word search" }] : [] }; }
  const looks = (parsed.looks ?? []).filter((l) => l && l.how && l.what).slice(0, 12);
  const node = { find: "run/gather/gfind", similar: "run/gather/gsim", near: "run/gather/gnear", open: "run/gather/gopen", web: "run/gather/gweb" } as const;
  const refs = await timed(ctx, "run/fetch", "event", `Fetch at once: ${looks.length} look(s)`, async () => {
    const results = await Promise.all(looks.map(async (l) => {
      const n = node[l.how] ?? "run/gather/gfind";
      try {
        return await timed(ctx, n, "act", `${l.how} ${l.what}`.slice(0, 200), async (): Promise<Ref[]> => {
          if (l.how === "find") return (await find(ctx, l.what)).map((r) => ({ ...r, why: l.why }));
          if (l.how === "similar") return (await similar(ctx, l.what)).refs.map((r) => ({ ...r, why: l.why }));
          if (l.how === "near") return near(ctx, l.what.replace(/^[bp]:/, ""));
          if (l.how === "web") { const w = await web(ctx, l.what); return w.ref ? [{ ...w.ref, why: l.why }] : [{ kind: "code", id: `blocked:${w.blocked}`, why: w.text }]; }
          const what = l.what.trim();
          if (what.startsWith("map:")) return [{ kind: "map", id: what.slice(4), why: l.why }];
          if (what.startsWith("code:")) return [{ kind: "code", id: what.slice(5), why: l.why }];
          const id = what.replace(/^\[\[|\]\]$/g, "").replace(/^[bps]:/, "");
          for (const kind of ["page", "brick", "source"] as const) if (await render(ctx, { kind, id })) return [{ kind, id, why: l.why }];
          return [];
        }, (r) => ({ detail: { found: r.map((x) => `${x.kind}:${x.id}`).slice(0, 30) } }));
      } catch {
        return [] as Ref[];
      }
    }));
    return results.flat();
  }, (r) => ({ charsOut: r.length }));
  return { refs, tier: parsed.model === "deep" ? "deep" : "main", plan: looks };
}

interface PackItem { ref: Ref; text: string }

/** The context pack: references only in storage; text resolved here, up to the knob. */
async function buildPack(ctx: RunCtx, refs: Ref[], st: Starter, carried: PackItem[] = []): Promise<PackItem[]> {
  const order = { map: 0, code: 0, page: 1, brick: 2, source: 3, web: 3 } as Record<string, number>;
  const seen = new Set(carried.map((p) => `${p.ref.kind}:${p.ref.id}`));
  for (const b of st.named) seen.add(`brick:${b.id}`);
  const items = [...carried];
  let used = carried.reduce((n, p) => n + p.text.length, 0);
  for (const ref of [...refs].sort((a, b) => (order[a.kind] ?? 4) - (order[b.kind] ?? 4))) {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let text = "";
    if (ref.kind === "map") text = MAP_PATHS.has(ref.id) || ref.id === "" ? explainPaths([ref.id]) : `map:${ref.id} is not a part of the map.`;
    else if (ref.kind === "code") text = ref.id.startsWith("blocked:") ? `A web search was refused by code: ${ref.why}` : `CODE ${ref.id}\n${readCode(ref.id).slice(0, 20_000)}`;
    else text = await render(ctx, ref);
    if (!text) continue;
    if (used + text.length > KNOBS.contextPackChars) {
      if (used > KNOBS.contextPackChars * 0.9) break;
      text = text.slice(0, KNOBS.contextPackChars - used);
    }
    used += text.length;
    items.push({ ref, text });
  }
  return items;
}

function lit(items: PackItem[], st: Starter) {
  return {
    bricks: [...new Set([...items.filter((i) => i.ref.kind === "brick").map((i) => i.ref.id), ...st.named.map((b) => b.id)])],
    pages: items.filter((i) => i.ref.kind === "page").map((i) => i.ref.id),
    sources: items.filter((i) => i.ref.kind === "source" || i.ref.kind === "web").map((i) => i.ref.id),
    life: Boolean(st.lifeId),
  };
}

export interface Intention {
  what?: string; grade?: string; hand?: string | null; args?: Record<string, unknown>; why?: string;
  request?: { title?: string; kind?: string; problem?: string; proposal?: string; prediction?: string; unblocks?: string[]; depends_on?: string[]; target?: string };
  bench?: { kind?: string; title?: string; body?: string; target?: string };
  note?: string; about?: string[]; promise?: { at?: string; purpose?: string };
}
interface Grading { intentions?: Intention[]; used?: string[]; refs?: string[] }

/** Split call A's text: DRAFT, (OPEN), REPLY, INTENTIONS. Tolerant of markdown around the headers. */
export function splitCallA(text: string): { draft: string; open: string | null; reply: string; tail: string } {
  const header = (name: string) => new RegExp(`(?:^|\\n)\\s*(?:#+\\s*)?\\**${name}:?\\**[ \\t]*\\n?`, "i");
  const r = header("REPLY").exec(text);
  const t = header("INTENTIONS").exec(text);
  const d = header("DRAFT").exec(text);
  const replyStart = r ? r.index + r[0].length : -1;
  const tailStart = t ? t.index : text.length;
  const draftEnd = r ? r.index : t ? t.index : text.length;
  const draft = text.slice(d ? d.index + d[0].length : 0, draftEnd).trim();
  const openMatch = /(?:^|\n)\s*OPEN:\s*(.+)/.exec(r ? text.slice(0, r.index) : text.slice(0, tailStart));
  const reply = r ? text.slice(replyStart, t && t.index > replyStart ? t.index : text.length).trim() : (d || openMatch ? "" : text.slice(0, tailStart).trim());
  return { draft, open: openMatch && !r ? openMatch[1].trim() : null, reply, tail: t ? text.slice(t.index + t[0].length) : "" };
}

function callAPrompt(st: Starter, pack: PackItem[], input: RunInput, trigger: string, once: boolean): string {
  const ask = input.message
    ? `ISAAK'S MESSAGE:\n${input.message}`
    : `NO MESSAGE: this is your own time (${trigger}). Purpose: ${input.purpose}\nYour REPLY is a note for your own record; anything for Isaak goes on his bench through an intention.`;
  return `TASK: callA
${ask}
${input.extra ? `\nMATERIAL CODE HANDED THIS RUN:\n${input.extra}\n` : ""}
=== THE STARTER ===
${st.text}

=== THE CONTEXT PACK (what you chose to look at) ===
${pack.map((p) => p.text).join("\n\n") || "(empty)"}

=== HOW TO ANSWER ===
Write three parts, in this order, with these exact headers:
DRAFT:
What would a highly capable person with your memory and a computer actually do now, including what you'd need to do it well and to discuss it with Isaak? Write it as a working draft: what you know (cite it), what you would do with which hand, what you lack and how you would get it.${once ? "" : "\nIf something essential is missing from what you see, end the draft with one line OPEN: <what to look at> and stop there; you get one more look, once."}
REPLY:
${input.message ? "What Isaak reads. Plain words, short, in his language. Say which part came from your memory and which from the web, and flag disagreements. Cite. If you point at parts of yourself, use [[map:path|label]]." : "A short note of what you did and concluded, for your own record."}
INTENTIONS:
One JSON object: {"intentions":[{"what":"...","grade":"done|partly|for_isaak|cant|change|thought","hand":"<hand name, for done and partly>","args":{...},"why":"...","request":{"title":"...","kind":"hand|change|intake|view|…","problem":"...","proposal":"what you would do with it","prediction":"what should improve, measurably","unblocks":["titles of requests this enables"]},"bench":{"kind":"draft|suggestion|question|checkin","title":"...","body":"..."},"note":"a thought, filed as your own","about":["brick ids the thought is about"],"promise":{"at":"ISO time","purpose":"..."}}],"used":["ids from the pack and starter you actually used"],"refs":["map paths you pointed at"]}
Grades: done = a hand fits and you carry it out; partly = do what a hand can now, and a request for the rest; for_isaak = his call (people, money, private matters, his decision): a bench item; cant = you lack the hand: a request (an enabling one first, if others depend on it); change = something about how you work: a request; thought = your conclusion, filed as your own.
Anything you promise to do later needs a promise with a time: that becomes a scheduled run.`;
}

const PROMISE = /\b(I'll|I will|I'm going to|I am going to)\b[^.!?\n]*\b(later|tomorrow|tonight|next week|weekly|every|check|follow up|get back|come back|remind)\b[^.!?\n]*[.!?]?/i;

/** The whole run engine. Returns the reply text (or the own-time note). */
export async function runEngine(ctx: RunCtx, run: Run, input: RunInput): Promise<{ reply: string; intentions: Intention[] }> {
  const system = await systemPrompt(ctx);
  const st = await starter(ctx, input);
  let { refs, tier, plan } = await gather(ctx, st, input, system);
  let pack = await buildPack(ctx, refs, st);
  await logStep(ctx, { node: "run/pack", kind: "event", label: `Context pack: ${pack.length} item(s), ${pack.reduce((n, p) => n + p.text.length, 0)} characters`, charsOut: pack.reduce((n, p) => n + p.text.length, 0), lit: lit(pack, st), detail: { plan } });
  const isYou = Boolean(input.message);
  let streamed = "";
  let replyId: string | null = null;
  const onDelta = (buffer: { text: string }) => (chunk: string) => {
    buffer.text += chunk;
    if (!isYou) return;
    const parts = splitCallA(buffer.text);
    if (!/(?:^|\n)\s*(?:#+\s*)?\**REPLY:?/i.test(buffer.text)) return;
    const visible = parts.reply.replace(/\n\s*\**INTENTIONS?:?\**[\s\S]*$/i, "").replace(/\n\s*\**I(N(T(E(N(T(I(O(N(S)?)?)?)?)?)?)?)?)?\s*$/i, "");
    if (visible.length > streamed.length && visible.startsWith(streamed)) {
      emit(ctx.userId, { type: "delta", runId: ctx.runId, text: visible.slice(streamed.length) });
      streamed = visible;
    }
  };
  let buffer = { text: "" };
  let a = await timed(ctx, "run/callA", "call", "Call A: draft, then the reply", () => ctx.ai.call({ task: "callA", tier, system, prompt: callAPrompt(st, pack, input, run.trigger, false), onDelta: onDelta(buffer) }),
    (r) => ({ model: r.model, charsIn: r.charsIn, charsOut: r.charsOut, detail: { text: r.text.slice(0, 20_000), fellBack: r.fellBack } }));
  let parts = splitCallA(a.text);
  if (parts.open && !parts.reply) {
    await logStep(ctx, { node: "run/more", kind: "event", label: `OPEN: ${parts.open}`.slice(0, 300) });
    const more = await gather(ctx, st, input, system, parts.open);
    plan = [...plan, ...more.plan];
    pack = await buildPack(ctx, more.refs, st, pack);
    await logStep(ctx, { node: "run/pack", kind: "event", label: `Context pack after one more look: ${pack.length} item(s)`, lit: lit(pack, st) });
    buffer = { text: "" };
    streamed = "";
    a = await timed(ctx, "run/callA", "call", "Call A again, with the extra look", () => ctx.ai.call({ task: "callA", tier, system, prompt: callAPrompt(st, pack, input, run.trigger, true), onDelta: onDelta(buffer) }),
      (r) => ({ model: r.model, charsIn: r.charsIn, charsOut: r.charsOut, detail: { text: r.text.slice(0, 20_000) } }));
    parts = splitCallA(a.text);
  }
  const reply = parts.reply || (parts.draft ? "I worked on this but my answer came out without a reply part; the draft is in my record." : a.text.trim());
  if (isYou) {
    const row = await addStream(ctx, { kind: "its", content: reply, runId: ctx.runId });
    replyId = row.id;
    await logStep(ctx, { node: "run/reply", kind: "event", label: "Reply done", charsOut: reply.length, detail: { streamId: replyId } });
  } else {
    await logStep(ctx, { node: "run/reply", kind: "event", label: "Own-time note written (not sent to the chat)", charsOut: reply.length });
  }

  // 4. Grading: first try call A's structured tail (saves a call); if malformed, a separate call B.
  let grading: Grading | null = null;
  try { if (parts.tail.trim()) grading = extractJson(parts.tail) as Grading; } catch { grading = null; }
  if (grading && Array.isArray(grading.intentions)) {
    await logStep(ctx, { node: "run/callB", kind: "event", label: `Grading from call A's tail: ${grading.intentions.length} intention(s), no call B needed` });
  } else {
    const b = await timed(ctx, "run/callB", "call", "Call B: grade every intention against the hands", () => ctx.ai.call({
      task: "callB", tier: "main", json: true, system,
      prompt: `TASK: callB\nYour draft and reply are below. Grade every intention in them against your hands (listed in your system text), as one JSON object {"intentions":[...],"used":[...],"refs":[...]} with the same fields as asked of call A: what, grade (done|partly|for_isaak|cant|change|thought), hand, args, why, request, bench, note, about, promise.\n\nDRAFT:\n${parts.draft}\n\nREPLY:\n${reply}`,
    }), (r) => ({ model: r.model, charsIn: r.charsIn, charsOut: r.charsOut }));
    try { grading = extractJson(b.text) as Grading; } catch { grading = { intentions: [] }; await logStep(ctx, { node: "run/callB", kind: "event", label: "Call B's answer was not JSON: nothing acted on", ok: false }); }
  }
  const intentions = (grading?.intentions ?? []).filter(Boolean).slice(0, 40);

  // 5. Acts
  let promised = false;
  for (const it of intentions) {
    const grade = (it.grade ?? "thought").toLowerCase().replace(/[\s-]/g, "_");
    const gradeNode = { done: "run/callB/done", partly: "run/callB/partly", for_isaak: "run/callB/forI", cant: "run/callB/cant", "can't": "run/callB/cant", change: "run/callB/change", thought: "run/callB/thought" }[grade] ?? "run/callB/thought";
    await logStep(ctx, { node: gradeNode, kind: "event", label: `${grade}: ${it.what ?? ""}`.slice(0, 300), detail: { intention: it } });
    if ((grade === "done" || grade === "partly") && it.hand) {
      const result = await act(ctx, it.hand, it.args ?? {});
      await logStep(ctx, { node: "run/acts", kind: "event", label: `${it.hand}: ${result.ok ? "done" : "failed"} — ${result.result}`.slice(0, 300), ok: result.ok });
      if (it.hand === "schedule_run" && result.ok) promised = true;
    }
    if (grade === "partly" || grade === "cant" || grade === "can't" || grade === "change") {
      const req = it.request ?? {};
      const { request, isNew } = await addRequestOrEvidence(ctx, { title: req.title || it.what || "a missing hand", kind: req.kind ?? (grade === "change" ? "change" : "hand"), problem: req.problem ?? it.why ?? "", proposal: req.proposal ?? "", prediction: req.prediction ?? "", unblocks: req.unblocks, dependsOn: req.depends_on, target: req.target });
      await logStep(ctx, { node: "run/gaps", kind: "event", label: `${isNew ? "New request" : "Evidence added"}: ${request.title} (${request.evidenceCount} run(s), ${request.status})`.slice(0, 300) });
      await logStep(ctx, { node: "requests/rdesk", kind: "event", label: `The desk: "${request.title}" has ${request.evidenceCount} run(s) of evidence${request.status === "ready" ? ", ready" : ""}`.slice(0, 300) });
    }
    if (grade === "for_isaak") {
      const bench = it.bench ?? {};
      const kind = (["draft", "suggestion", "question", "checkin"].includes(bench.kind ?? "") ? bench.kind : "suggestion") as BenchKind;
      await putOnBench(ctx, { kind, title: bench.title || it.what || "for you", body: bench.body || it.why || "", target: bench.target });
      await logStep(ctx, { node: "hands/hbench", kind: "act", label: `On your bench: ${bench.title || it.what}`.slice(0, 300) });
    }
    if (grade === "thought") {
      const note = it.note || it.what || "";
      if (note) {
        const { source } = await addSource(ctx, { kind: "own", title: `Its note: ${note.slice(0, 80)}`, body: note, filed: true });
        for (const about of it.about ?? []) {
          await ctx.db.query(`INSERT INTO entries (id, user_id, brick_id, kind, text, origin, source_id, run_id, created_at) SELECT $1,$2,id,'conclusion',$4,'own',$5,$6,$7 FROM bricks WHERE user_id=$2 AND id=$3 AND archived_at IS NULL`,
            [sid(), ctx.userId, about, note, source.id, ctx.runId, ctx.now().toISOString()]);
        }
        await logStep(ctx, { node: "run/thoughts", kind: "event", label: `Thought filed as its own: ${note}`.slice(0, 300), lit: { sources: [source.id], bricks: it.about ?? [] } });
      }
    }
    if (it.promise?.at) {
      const result = await act(ctx, "schedule_run", { at: it.promise.at, purpose: it.promise.purpose ?? it.what ?? "a promise", why: `promised in run ${ctx.runId}`, goal_id: run.parentGoalId ?? undefined });
      if (result.ok) promised = true;
    }
  }
  // Promises must produce a scheduled run (code checks the reply).
  const promiseText = PROMISE.exec(reply)?.[0];
  if (promiseText && !promised) {
    const due = new Date(ctx.now().getTime() + 24 * 3600_000).toISOString();
    await logStep(ctx, { node: "run/callB", kind: "event", label: `A promise with nothing behind it: "${promiseText.slice(0, 120)}". Code scheduled a follow-up run for ${due.slice(0, 16)}.`, ok: false });
    await act(ctx, "schedule_run", { at: due, purpose: `Follow up on what you promised: "${promiseText.slice(0, 200)}"`, why: "code: a promise in a reply had no scheduled run" });
  }

  // 6. What it actually used, and the record.
  const cited = new Set<string>([...citations(`${parts.draft}\n${reply}`).map((c) => c.id), ...(grading?.used ?? []).map((u) => String(u).replace(/^[bps]:/, ""))]);
  const contents = pack.map((p) => ({ kind: p.ref.kind, id: p.ref.id, range: p.ref.range, chars: p.text.length, why: p.ref.why }));
  const used = contents.filter((c) => cited.has(c.id)).map((c) => c.id);
  await ctx.db.query(`INSERT INTO packs (id, user_id, run_id, contents, used, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [sid(), ctx.userId, ctx.runId, JSON.stringify(contents), JSON.stringify(used), ctx.now().toISOString()]);
  await touchBricks(ctx, [...cited], true);
  await touchPages(ctx, [...cited]);
  const refsOut = [...new Set([...(grading?.refs ?? []), ...[...reply.matchAll(/\[\[map:([^|\]]+)/g)].map((m) => m[1])])].filter((p) => MAP_PATHS.has(p));
  if (refsOut.length) emit(ctx.userId, { type: "refs", runId: ctx.runId, refs: refsOut });
  if (run.parentGoalId) await stepGoal(ctx, run.parentGoalId, `run ${ctx.runId}: ${reply.slice(0, 300)}`).catch(() => undefined);
  const packChars = contents.reduce((n, c) => n + c.chars, 0);
  const usedChars = contents.filter((c) => used.includes(c.id)).reduce((n, c) => n + c.chars, 0);
  await logStep(ctx, { node: "run/record", kind: "event", label: `Run record saved: ${intentions.length} intention(s); the drafts used ${used.length} of ${contents.length} pack items (${packChars ? Math.round((usedChars / packChars) * 100) : 0}% of the characters)`, detail: { used, refs: refsOut, replyId } });
  return { reply, intentions };
}
