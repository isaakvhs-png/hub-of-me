import type { CallOpts, CallResult, Models, Tier } from "./ai.js";

/**
 * The mock model: answers every task with plausible, deterministic output built from the prompt, so the whole system
 * (plumbing) runs with no key. The bench uses it; a case can script any task with `on(task, fn)`.
 * It tests plumbing, never judgment: judgment needs the real model (BUILD_SPEC §11a).
 */
type Script = (opts: CallOpts) => string | null | undefined;

const section = (prompt: string, header: string, next: RegExp = /\n(?:[A-Z][A-Z' "()-]{3,}[A-Z)"]:?\n|===)/): string => {
  const at = prompt.indexOf(header);
  if (at < 0) return "";
  const rest = prompt.slice(at + header.length);
  const end = rest.search(next);
  return (end >= 0 ? rest.slice(0, end) : rest).trim();
};

const STOP = new Set("The This That These Those And But Or If When Where What Which Who How Why I You We He She They It My Your Our His Her Their A An In On At For With From To Of Isaak YOU ISAAK Monday Tuesday Wednesday Thursday Friday Saturday Sunday".split(" "));

/** Capitalised phrases as "things": a cheap, deterministic stand-in for understanding. */
export function things(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b([A-Z][\p{L}\p{N}-]+(?:\s+(?:[A-Z][\p{L}\p{N}-]+|of|de|van|and))*)/gu)) {
    const name = m[1].replace(/\s+(of|de|van|and)$/, "").trim();
    if (name.length < 3 || STOP.has(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out.slice(0, 30);
}

export class MockModels implements Models {
  readonly mode = "mock" as const;
  readonly calls: { task: string; tier: Tier; prompt: string }[] = [];
  private scripts = new Map<string, Script[]>();

  modelFor(tier: Tier): string {
    return `mock-${tier}`;
  }

  /** Script a task. The newest script answers first; return null to fall through to the default. */
  on(task: string, fn: Script): this {
    this.scripts.set(task, [fn, ...(this.scripts.get(task) ?? [])]);
    return this;
  }

  async call(opts: CallOpts): Promise<CallResult> {
    const started = Date.now();
    this.calls.push({ task: opts.task, tier: opts.tier, prompt: opts.prompt });
    let text: string | null | undefined = null;
    for (const fn of this.scripts.get(opts.task) ?? []) { text = fn(opts); if (text != null) break; }
    if (text == null) text = this.default(opts);
    if (opts.onDelta) for (let i = 0; i < text.length; i += 40) opts.onDelta(text.slice(i, i + 40));
    return { text, model: this.modelFor(opts.tier), provider: "mock", ms: Date.now() - started, charsIn: opts.system.length + opts.prompt.length, charsOut: text.length };
  }

  private default(opts: CallOpts): string {
    const p = opts.prompt;
    switch (opts.task) {
      case "filing": return this.filing(p);
      case "gather": return this.gather(p);
      case "callA": return this.callA(p);
      case "callB": return JSON.stringify({ intentions: [{ what: "keep this as a note", grade: "thought", note: "Call B graded the draft: nothing to act on." }] });
      case "triage": return JSON.stringify({ matters: true, why: "mock: a member changed" });
      case "rewrite": {
        const body = section(p, "\nPAGE ", /\n\nWHY\n/).split("\n").slice(1).join("\n");
        const ids = [...p.matchAll(/\[\[b:([a-z0-9]{10})\]\]/g)].map((m) => m[1]).slice(0, 3);
        return JSON.stringify({ body: `${body}\n\nUpdated: ${ids.map((i) => `[[b:${i}]]`).join(" ")}`.trim(), change_note: "mock: added what changed", claim_changed: false });
      }
      case "web": return `Mock web result for "${section(p, "Query:", /$^/)}". Nothing real was searched.\nSOURCES:\n- Example — https://example.org`;
      case "revision": return JSON.stringify({ apply: true, change_note: "mock: applied his revision", reply: "Done." });
      case "review-draft": return `Mock review. ${/"questionsItsWebCouldAnswer":\s*\{\s*"count":\s*([1-9])/.test(p) ? "I asked Isaak something my web already held: my judgment (How I work with Isaak)." : "Nothing went wrong that the signals show."}`;
      case "review-actions": {
        const actions: unknown[] = [];
        if (/my judgment/.test(p)) actions.push({ type: "guide_revision", guide: "How I work with Isaak", body: "- Look in my own web before asking him (evidence: a question my web could answer, tonight's signals).", change_note: "look before asking", evidence: "signals: questions its web could answer" });
        const ready = [...p.matchAll(/([a-z0-9]{10}) "([^"]+)" \(ready/g)];
        if (ready.length) actions.push({ type: "bundle_proposal", title: `Proposal: ${ready[0][2]}`, why: "ready after enough runs", request_ids: ready.map((r) => r[1]), spec: "mock spec", prediction: "the signal behind it should drop", cost: "a builder session" });
        actions.push({ type: "track_record", line: "mock: the first night's review ran" });
        return JSON.stringify({ actions, report: `Mock report: ${actions.length} action(s).` });
      }
      default: return "{}";
    }
  }

  private filing(p: string): string {
    const part = section(p, "THE PART", /\n\nReturn one JSON object:/).split("\n").slice(1).join("\n");
    const index = section(p, "THE INDEX OF EVERY BRICK", /\n\nTHE PART/);
    const known = new Map<string, string>();
    for (const line of index.split("\n")) { const [id, name] = line.split(" | "); if (id && name) known.set(name.trim().toLowerCase(), id.trim()); }
    const sentences = part.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 3);
    const own = (s: string) => /\b(you work|how you|yourself|hub of me|your own)\b/i.test(s);
    const thingsOut: { ref?: string; name: string; kind: string; summary: string; corner: string; entries: { kind: string; text: string; quote: string; due?: string }[] }[] = [];
    const links: { a: string; b: string; relation: string; reason: string }[] = [];
    const updates: { brick: string; replaces: string; now: string }[] = [];
    for (const s of sentences) {
      const names = things(s);
      const corner = own(s) ? "own" : "his";
      if (!names.length && corner === "own") names.push("How Hub of Me works");
      for (const name of names) {
        let t = thingsOut.find((x) => x.name === name);
        if (!t) { t = { ...(known.has(name.toLowerCase()) ? { ref: known.get(name.toLowerCase()) } : {}), name, kind: "thing", summary: s.slice(0, 80), corner, entries: [] }; thingsOut.push(t); }
        const due = /\b(\d{4}-\d{2}-\d{2})\b/.exec(s)?.[1];
        t.entries.push({ kind: /\?$/.test(s) ? "question" : "fact", text: s, quote: s, ...(due ? { due } : {}) });
      }
      for (let i = 1; i < names.length; i += 1) links.push({ a: names[0], b: names[i], relation: /\bnot\b|\bbut\b/i.test(s) ? "contradicts" : "involves", reason: s.slice(0, 120) });
      const m = /\b([A-Z][\p{L}-]+) (?:now|actually) (.+)/u.exec(s);
      if (m) updates.push({ brick: m[1], replaces: m[2], now: s });
    }
    return JSON.stringify({ things: thingsOut, links: links.slice(0, 20), updates, note: { doubts: /two (\w+)s\b/i.test(part) ? [{ text: `two ${/two (\w+)s\b/i.exec(part)![1]}s?`, bricks: [] }] : [], missed: /\|.*\|/.test(part) ? ["a table was flattened"] : [] } });
  }

  private gather(p: string): string {
    const message = section(p, "ISAAK'S MESSAGE:", /\n\n(?:Parts of yourself|YOUR DRAFT|MATERIAL CODE)/) || section(p, "YOUR OWN TIME. Purpose:", /\n\n/);
    const extra = section(p, "MATERIAL CODE HANDED THIS RUN:", /\n\nParts of yourself/);
    const looks: { how: string; what: string; why: string }[] = [];
    const ids = [...`${message}\n${extra}`.matchAll(/\[\[([bp]):([a-z0-9]{10})\]\]/g)].map((m) => `${m[1]}:${m[2]}`);
    for (const id of ids.slice(0, 6)) looks.push({ how: "open", what: id, why: "named" });
    if (message) looks.push({ how: "find", what: message.slice(0, 200), why: "his words" }, { how: "similar", what: message.slice(0, 300), why: "same meaning" });
    if (/how (do|does) (you|it)|how you work|yourself|your own|diagnose you/i.test(message)) looks.push({ how: "open", what: "map:upkeep", why: "a question about how I work" });
    if (/\b(search|online|look up|on the web|internet)\b/i.test(message)) looks.push({ how: "web", what: message.slice(0, 120), why: "he asked for the web" });
    if (/first pages|life document|brick upkeep/i.test(message + extra)) for (const m of [...p.matchAll(/\[\[p:([a-z0-9]{10})\]\]/g)].slice(0, 4)) looks.push({ how: "open", what: `p:${m[1]}`, why: "a theme" });
    return JSON.stringify({ looks, model: "main", why_model: "mock" });
  }

  private callA(p: string): string {
    const message = section(p, "ISAAK'S MESSAGE:", /\n\n(?:MATERIAL CODE|=== THE STARTER)/);
    const purpose = section(p, "Purpose:", /\n/);
    const pack = section(p, "=== THE CONTEXT PACK (what you chose to look at) ===", /\n=== HOW TO ANSWER ===/);
    const starterText = section(p, "=== THE STARTER ===", /\n=== THE CONTEXT PACK/);
    const bricks = [...new Set([...pack.matchAll(/\[\[b:([a-z0-9]{10})\]\]/g), ...starterText.matchAll(/\[\[b:([a-z0-9]{10})\]\]/g)].map((m) => m[1]))];
    const pages = [...new Set([...pack.matchAll(/\[\[p:([a-z0-9]{10})\]\] PAGE/g)].map((m) => m[1]))];
    const intentions: Record<string, unknown>[] = [];
    let reply = message ? `(mock) I read your message${bricks.length ? ` next to what I hold: ${bricks.slice(0, 3).map((b) => `[[b:${b}]]`).join(", ")}` : ""}.` : `(mock) Own time: ${purpose}`;
    const refs: string[] = [];
    if (/make it visual|can't see how you work|show me how you work|diagnose you/i.test(message)) {
      reply = "I can't sketch anything for you yet: I have no hand to make pages you can see. I've asked for that first; the run view depends on it. Meanwhile, today's runs are in my record.";
      intentions.push({ what: "make a visual view of how I work", grade: "cant", request: { title: "Let me make pages Isaak can see", kind: "hand", problem: "I cannot show him anything visual", proposal: "a page-making hand", prediction: "he can diagnose me from a view", unblocks: ["A live view of my runs"] } });
      intentions.push({ what: "a live view of my runs", grade: "cant", request: { title: "A live view of my runs", kind: "view", problem: "he cannot see how I work", proposal: "draw my runs as a page", depends_on: ["Let me make pages Isaak can see"] } });
    }
    if (/instagram|reel/i.test(message)) {
      reply = "A capable person would watch them. I can't open Instagram. Ways in: you save the videos and drop the files, and a model that can watch video gives transcript and what's on screen; or you paste the captions. Cheapest that works: the files plus video intake. Until then, could you paste the captions?";
      intentions.push({ what: "take in video and audio", grade: "cant", request: { title: "Take in video and audio", kind: "intake", problem: "I can't open or watch videos", proposal: "files plus a model that watches video (Gemini)", prediction: "reels he sends become sources" } });
      intentions.push({ what: "ask for the captions meanwhile", grade: "for_isaak", bench: { kind: "question", title: "Could you paste the reels' captions?", body: "Until I can take in video, the captions are the way in." } });
    }
    if (/how do you decide|how do you work|how does .* work/i.test(message)) {
      reply = "When something changes I notice it in six ways [[map:upkeep/routes|Six stale routes]]; it waits in [[map:upkeep/squeue|the stale queue]]; a fast model asks whether it matters [[map:upkeep/triage|Triage]]; only a changed claim goes up [[map:upkeep/claim|Claim changed?]].";
      refs.push("upkeep/routes", "upkeep/squeue", "upkeep/triage", "upkeep/claim");
    }
    if (/remind|check (back|again)|later|next week/i.test(message)) {
      const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
      reply += " I'll check back on this in two days.";
      intentions.push({ what: "check back in two days", grade: "done", hand: "schedule_run", args: { at, purpose: `check back: ${message.slice(0, 80)}`, why: "he asked" } });
    }
    if (/wrong date|you're wrong|that's wrong/i.test(message)) reply = "I think that's not right: my notes say otherwise. I'll do it your way if you still want that.";
    if (/first pages|life document/i.test(purpose) && bricks.length >= 3) {
      const themeBricks = bricks.slice(0, Math.min(8, bricks.length));
      intentions.push({ what: "write a first page", grade: "done", hand: "write_page", args: { title: "First theme", purpose: "What the first files are about", body: `A first theme from what was filed: ${themeBricks.map((b) => `[[b:${b}]]`).join(", ")}.` } });
      if (pages.length || bricks.length >= 6) intentions.push({ what: "write the life document", grade: "done", hand: "write_page", args: { kind: "life", title: "Isaak's life", purpose: "Who Isaak is and where he's going, as far as I know", body: `## Now\nFrom the first files: ${themeBricks.slice(0, 4).map((b) => `[[b:${b}]]`).join(", ")}.` } });
      intentions.push({ what: "a check-in on the first pages", grade: "for_isaak", bench: { kind: "checkin", title: "I wrote the first pages: do they ring true?", body: "From what you sent." } });
    }
    if (!intentions.length) intentions.push({ what: "note what this was about", grade: "thought", note: `About: ${(message || purpose).slice(0, 120)}`, about: bricks.slice(0, 2) });
    return `DRAFT:\n(mock) What a capable person would do: read what I hold, then answer. ${bricks.slice(0, 2).map((b) => `[[b:${b}]]`).join(" ")}\nREPLY:\n${reply}\nINTENTIONS:\n${JSON.stringify({ intentions, used: bricks.slice(0, 3), refs })}`;
  }
}
