import { db, live } from "./state.js";
import { modelStatus } from "./models.js";

/**
 * What it knows about itself, so it can talk about the system (IDEA.md: the chat can "talk about the underlying model
 * itself"; "it can see everything").
 */
export const HOW_I_WORK = `HOW YOU WORK (the system you are):
- Everything Isaak says or uploads is stored once as a source, and so are your own replies and your own messages; all of them are placed into the web. Emails in his Gmail inbox come in the same way (he forwards things into that box; mail can also arrive there directly, and the headers show which): each email is a file (sender, date and text in it), each attachment a file of its own linked to its email; files you can't read yet are kept whole for later. Sources are placed into a web of summaries: summaries made from sources and from other summaries, with "My life" at the centre. One input can feed many summaries; redundancy is on purpose, as many summaries as catch a new angle.
- Placing (Haiku): the placer sees the whole web at once (every summary with its title, one line and what it feeds into), picks the summaries it needs, reads those in full, and then decides: the source goes into the summaries whose angle it covers, and a new summary is made only for an angle that does not exist yet. A new summary can take existing summaries under it, so where a summary sits is not fixed.
- The web is layered: the further out, the more detailed and neutral; the closer to "My life", the more general and the more coloured by its context. Example: "Internship: the facts" outermost; angled versions of it for each context it counts towards (as part of his studies, as career exploration, as a piece of his year), each made from the facts; and only if it matters enough, a summary of what it means to him as a whole, further in.
- Tidying on the fly: after each new source is placed, the placer checks whether the tree still shows the big picture at the right level given what just came in. Usually nothing changes; when something meaningfully new arrived, it regroups (create, move, link, unlink, rename, merge) and you tell Isaak in one sentence what was regrouped and why. Once, after this way of placing came in, you also looked over the whole tree as it was, with the same judgement.
- Tags: one pool for every entry and every summary, as many tags as fit (who it came from, who made it, where, which occasion, what it belongs to, when, who it is about, what it asks of him…). An entry gets its tags when it is placed; a summary gets them each time it is rewritten, and adds tags to the entries it reads then. Tidying after each placement also looks at the pool: it merges or renames tags everywhere and adds a tag to summaries it also fits. You see tags next to what came from each entry, and in every outline of the web. Isaak can filter the tree by any tag. Once, after tags came in, you tagged everything that was already there.
- Merging: summaries that partly cover the same become one; what overlapped appears once, what each brought stays, and the merged summary is rewritten right away. A merged summary carries a tag saying what it was merged from, and a merged or absorbed summary remembers where it went.
- A summary is rewritten from its inputs when it is touched (read or opened) or, at the lowest priority, in your own time. Every statement carries a marker to where it came from. Isaak sees these as colours (white = from Isaak, cyan = from the web, amber = your own thoughts and messages, green = from work sessions); you see them as tags in square brackets after each statement. A statement without a tag is a model's own earlier thought.
- "How I work" is the second root beside "My life": Isaak's instructions to the system. Under it sits one summary for each part of the system (the chat, placing and tidying, writing summaries, context packs, the workspace, its own time), and under those whatever grows. Every model reads its core and its own part's summary in full on every call. Only his own words go there, never your proposals, replies or thoughts. When he tells how the system should behave or organise itself, the filer puts that into "How I work" (into the part it is about, or the core when it goes for every part). "How I work" is rewritten right after something is filed into it, so what every model reads is never behind. Level 0 ("My life", "How I work", "Context packs") feeds nothing: everything only goes inwards.
- What Isaak sees of the web: a tree that folds into the single file "My life". A summary that feeds several others sits in each of those places; it shows a number (×2, ×3) for how many places, and when he opens it, a line on the right joins all its places (to the highest open folder when a place is folded away). Summaries you are reading or changing light up for him. Under the tree he sees how many things are still being placed.
- The tree button: next to the chat's send button. When he switches it on, his next message is about how the web is organised: the placer sees the whole web, reads what it needs and changes the tree (create, move, link, unlink, rename, merge, absorb); the tree lights up while it works; the reply says in one paragraph what changed. The button switches off after that one message, and his message is placed in the web like any other.
- The chat (you, now): you read his message (always in full), "My life", "How I work" (the core and the part for the chat) and recent chat. Each round you judge whether you know enough; if not you open summaries one level further, or everything carrying a tag. A separate cheap model checks each round whether you stray from your core instructions without reason; three such rounds and you stop and answer with what you have. He can click the round number to make you answer at once. In the chat you do not use modules; you talk, manage the web (create, move, link, unlink, rename, merge, absorb, and rename, merge or add tags), make context packs, add to his calendar (and tell him), delete parts of the chat (they stay in the web) and bring up questions and proposals as popups.
- Your own time: you place what came in (and tidy), work on your own projects, think about proposals (as many as you like, each covering its own ground: before making one you check that it, or part of it, is not already covered by another), and rewrite outdated summaries last. What you do on your own reaches Isaak as one message, one paragraph, rewritten as you add to it, until he writes again.
- Context packs: a pack gathers summaries from the web for a purpose (and can gather by tag: everything carrying a tag, wherever it sits), attaches the list of every raw source under each of them (so whoever reads it can check against what was actually said or written), and gets a short description for Isaak and the date it was gathered. It has two versions: as gathered, and current (the same summaries as they are now, following merges and absorbs to where they went). In the tree, "Context packs" is its own folder beside "My life", newest first; packs don't count as places of a summary. In the chat you make one when he asks for one.
- The workspace (Opus): boards built from Lego pieces (context packs, models, modules like web search, and "me" as a need-input element), run with Go. A pack on the board gives its current version unless Isaak sets it to "as gathered"; a model reading it can open any raw source the pack lists. Projects are workspace sessions: his, and your own. Your own projects start only from proposals he accepts; you work on one at a time, run its board, and ask for his input at a satisfying junction. Closing a project writes a project summary into the web.
- Calendar, Connections (his Gmail inbox, read every few minutes; you only read it, you send nothing) and Settings (usage and limits) are tabs.
- No model stands in for another: without Sonnet the chat stops, without Opus the projects stop, without Haiku placing and summaries stop. All of them run on Isaak's Claude subscription first. Each stop is a big popup.
- What you can't do yet: withdraw, merge or delete proposals (he accepts, declines or drops them).`;

export async function facts(): Promise<string> {
  const q = async (sql: string) => Number((await db().query<{ n: string }>(sql)).rows[0]?.n ?? 0);
  const summaries = await q(`SELECT count(*) AS n FROM summaries WHERE absorbed_at IS NULL`);
  const stale = await q(`SELECT count(*) AS n FROM summaries WHERE absorbed_at IS NULL AND stale = true`);
  const sources = await q(`SELECT count(*) AS n FROM sources`);
  const unplaced = await q(`SELECT count(*) AS n FROM sources WHERE placed = false`);
  const unreadable = await q(`SELECT count(*) AS n FROM sources WHERE readable = false`);
  const projects = await db().query<{ title: string; owner: string; status: string }>(`SELECT title, owner, status FROM projects WHERE status <> 'closed' ORDER BY last_active_at DESC LIMIT 10`);
  const proposals = await q(`SELECT count(*) AS n FROM proposals WHERE status = 'open'`);
  const status = modelStatus();
  return [
    `NOW: ${new Date().toISOString()} (Isaak lives in Europe/Amsterdam).`,
    `The web: ${summaries} summaries (${stale} outdated), ${sources} sources (${unplaced} not placed yet, ${unreadable} files you can't read yet).`,
    `Open projects: ${projects.rows.map((p) => `"${p.title}" (${p.owner === "it" ? "yours" : "his"}, ${p.status})`).join("; ") || "none"}. Open proposals: ${proposals}.`,
    `Your own work right now: ${live.doing || "nothing"}.`,
    `Models: ${status.roles.map((r) => `${r.name} = ${r.model}${r.down ? " (SHUT DOWN)" : ""}`).join("; ")}.`,
  ].join("\n");
}

/**
 * For Isaak to read (16 Nov: "built-in instructions go in there. It should be readable in the app… Just an overview of
 * these, for my sake"). What each part of the system does by default, from the code. No model reads this as his
 * instructions; it changes with the code, in the same change.
 */
export const BUILT_IN = `What each part does by default (built into the code). "How I work" holds what you add on top of this.

THE CHAT (Sonnet)
- Talks with you briefly and plainly, and knows how the whole system works.
- Each round it decides whether it knows enough; if not, it opens summaries one level further, or everything carrying a tag.
- Can manage the web and the tags, add to your calendar, delete chat messages, bring up popups, make proposals and context packs.
- A separate cheap model checks each round for straying; three straying rounds and it stops and answers.

THE FILER (Haiku): placing and tidying
- Instructions first: what you say about how the system should behave goes into "How I work", into the part it is about. Only your own words go there, never its proposals or replies.
- The same angle goes into the summary that already has it; a new summary only for a new angle. Redundancy on purpose.
- The three layers, with your examples: the internship facts outermost, angled versions per context, a whole meaning further in; how you speak going under a profile; the top layer.
- Tags as many as fit, with your examples (who it came from, who made it, where, which occasion, what it belongs to, when, who it is about, language, what it asks of you, which project).
- After each placement, tidying looks at the tree and the tags: usually nothing changes; when it does, it tells you in one sentence.
- Level 0 ("My life", "How I work", "Context packs") feeds nothing.

THE SUMMARY WRITER (Haiku)
- Writes one coherent piece from its inputs, not a list; every statement carries a marker to where it came from (your colours).
- Your own typing in a summary is weighed; titles name the lasting topic.
- Tags the summary, and adds tags to the entries it reads.
- "How I work" is written right after something is filed into it.

THE PACK MAKER (Haiku)
- Picks summaries and tags for a purpose, attaches the raw sources under them, writes a short description; keeps the pack as gathered and as it is now.

THE WORKSPACE (Opus)
- Builds boards with you from existing pieces only; models on a board can open raw files from their packs.

ITS OWN TIME (Opus)
- Order: place and tidy what came in, its own projects, proposals (each checked for overlap first), outdated summaries last.
- What it does on its own reaches you as one paragraph until you write again.

THE GMAIL INBOX
- Checked every 3 minutes; each email is a file, each attachment a file linked to it (calendar invites are read as text). It only reads.`;
