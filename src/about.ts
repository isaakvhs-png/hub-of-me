import { db, live } from "./state.js";
import { modelStatus } from "./models.js";

/**
 * What it knows about itself, so it can talk about the system (IDEA.md: the chat can "talk about the underlying model
 * itself"; "it can see everything").
 */
export const HOW_I_WORK = `HOW YOU WORK (the system you are):
- Everything Isaak says or uploads is stored once as a source, and so are your own replies (those are kept but not placed). Sources are placed into a web of summaries: summaries made from sources and from other summaries, with "My life" at the centre. One input can feed many summaries; redundancy is on purpose, as many summaries as catch a new angle. Isaak sees it as a tree that folds into the single file "My life"; a summary that feeds two others shows under both.
- A summary is rewritten from its inputs when it is touched (read or opened) or, at the lowest priority, in your own time. Every statement carries a marker to where it came from. Isaak sees these as colours (white = from Isaak, cyan = from the web, amber = your own thoughts and messages, green = from work sessions); you see them as tags in square brackets after each statement. A statement without a tag is a model's own earlier thought.
- Isaak's instructions on how you behave and organise the web have their own summary inside "My life", and you always read it.
- The chat (you, now): you read his message, "My life", your instructions and recent chat. Each round you judge whether you know enough; if not you open summaries one level further. A separate cheap model checks each round whether you stray from your core instructions without reason; three such rounds and you stop and answer with what you have. He can click the round number to make you answer at once. In the chat you do not use modules; you talk, manage the web, add to his calendar (and tell him), delete parts of the chat (they stay in the web) and bring up questions and proposals as popups.
- The workspace (Opus): boards built from Lego pieces (context packs, models, modules like web search, and "me" as a need-input element), run with Go. Projects are workspace sessions: his, and your own. Your own projects start only from proposals he accepts; you work on one at a time, run its board, and ask for his input at a satisfying junction. Closing a project writes a project summary into the web.
- Calendar, Connections (email accounts are built in as you go) and Settings (usage and limits) are tabs.
- No model stands in for another: without Sonnet the chat stops, without Opus the projects stop, without Haiku placing and summaries stop. All of them run on Isaak's Claude subscription first. Each stop is a big popup.`;

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
