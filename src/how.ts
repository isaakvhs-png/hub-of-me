import { db } from "./state.js";

/**
 * "How I work" (Isaak, 16 Nov): his instructions to the system, a root of its own beside "My life". Its core holds what
 * goes for every part; under it one summary per part of the system holds what he said for that part. Every model call
 * reads the core and its own part's summary in full (only the check that a model is up reads nothing).
 */

export const PARTS = {
  chat: { title: "For the chat", desc: "the chat: you talk with Isaak" },
  placing: { title: "For placing and tidying", desc: "the filer: you place what comes in, tag it, and keep the tree and the tags in order" },
  summaries: { title: "For writing summaries", desc: "the summary writer: you write each summary from its inputs" },
  packs: { title: "For context packs", desc: "the pack maker: you gather context packs" },
  workspace: { title: "For the workspace", desc: "the workspace: you build boards with Isaak and run them" },
  own: { title: "For its own time", desc: "its own time: you think about proposals, work on your own projects, and tell Isaak what you did" },
} as const;
export type Part = keyof typeof PARTS;

const TASK_PART: Record<string, Part> = {
  chat: "chat", "chat-answer": "chat", "runaway-check": "chat",
  "place-candidates": "placing", place: "placing", tidy: "placing", "tree-candidates": "placing", tree: "placing", revise: "placing", "tag-source": "placing",
  rewrite: "summaries", "read-picture": "summaries",
  pack: "packs", "pack-description": "packs",
  workspace: "workspace", "board-step": "workspace", "run-summary": "workspace",
  "own-time": "own", "proposal-overlap": "own", "pick-project": "own", "judge-round": "own", "merge-own-work": "own",
};

const plainText = (body: string) => body.replace(/\[\[(?:s|m|img):[^\]]+\]\]/g, "").replace(/\{\{\/?isaak\}\}/g, "").replace(/[ \t]+\n/g, "\n").trim();

/** The block every model call gets after its own instructions. */
export async function howIWorkFor(task: string): Promise<string> {
  if (task === "probe") return "";
  const part = TASK_PART[task];
  let rows: { body: string; is_how: boolean; role: string }[] = [];
  try {
    rows = (await db().query<{ body: string; is_how: boolean; role: string }>(
      `SELECT body, is_how, role FROM summaries WHERE absorbed_at IS NULL AND (is_how = true OR role <> '')`)).rows;
  } catch { return ""; }
  const core = rows.find((r) => r.is_how);
  if (!core) return "";
  const mine = part ? rows.find((r) => r.role === part) : undefined;
  return `\n\nHOW ISAAK WANTS THE SYSTEM TO WORK ("How I work": every part of the system reads this on every call).${part ? ` Your part in the system: ${PARTS[part].desc}. The section "for you" is yours; the core goes for every part.` : ""}
CORE:
${plainText(core.body) || "(nothing yet)"}${part ? `\n\nFOR YOU (${PARTS[part].title}):\n${plainText(mine?.body ?? "") || "(nothing yet)"}` : ""}`;
}
