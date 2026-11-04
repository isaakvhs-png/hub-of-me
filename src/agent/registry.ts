import type { Effort } from "../ai/effort.js";

export interface ToolSpec {
  name: string;
  effort: Effort;
  description: string;
}

/**
 * What the entity can do. Each is an ability described plainly; none says when to use it, and none runs unless it names it.
 * Adding one widens what it can do without changing who it is (check every new one against DESIGN.md).
 */
export const TOOLS: ToolSpec[] = [
  { name: "notebook_write", effort: "light", description: "Remember something particular: a fact, a plan, a source, something he said. input: { title, summary, body, folder, kind, phrase, url }. summary is one line for your map. folder is a path you choose, like \"Kyoto/Thesis ideas\"; kind is what sort of note it is, in your own word. phrase: his words, copied from his message, if it came from there. url: the source, if it came from the web." },
  { name: "notebook_change", effort: "light", description: "Change or archive one of your notes; the old version is kept and can be undone. input: { id, title, summary, body, folder, kind, archive_why }. Give only what changes; archive_why archives it." },
  { name: "open_notes", effort: "light", description: "Choose which notes stay open in full in your memory window, when they no longer all fit. input: { open: [ids], close: [ids] }." },
  { name: "mark", effort: "light", description: "Point at a phrase in his message and show him where it is going, for anything you did with it that has no phrase of its own. input: { phrase, destination, label }. destination is where it goes, in your own words. (What you keep with a phrase lights up on its own.)" },
  { name: "todos", effort: "light", description: "The ledger of things to follow up. input: { action, title, why, owner, taskId, reason, phrase }. action is remember, fade (with a reason), or done (with a reason)." },
  { name: "calendar", effort: "light", description: "His calendar. input: { action, id, title, starts_at, ends_at, all_day, why, phrase }. action is add, move, or archive. Times are ISO with timezone." },
  { name: "read_file", effort: "light", description: "Read one attached file. Images and textless PDFs are read by sight. input: { name }." },
  { name: "look_at_myself", effort: "light", description: "Look at yourself: how you work (the machinery, written by your builders), every part of you in detail, your recent history (what you took in, intended and said), and the list of your own design and code files. input: { file } to read one of those files instead." },
  { name: "read_records", effort: "light", description: "Read your own records: thinking, actions, and soul changes since the fresh start. Use this before explaining what you did or why. Do not guess." },
  { name: "search", effort: "light", description: "Search the public web and read what comes back, with sources. input: { query, why }. Never put his private details or anyone's contact details in a query." },
  { name: "ask", effort: "conversation", description: "Hold a question for him, shown as a card he can answer, postpone, or refuse. input: { subject, question, context, why, expect }." },
  { name: "reflect", effort: "deep", description: "Step back and think something through, alone, in your own words. What you conclude can change your soul, your understanding of him (portrait and map), your intentions, and what you want to ask. input: { about }." },
  // LATER (Isaak, 4 Nov; see MIND_DESIGN.md §8): a "debate mode on the brain": a council of differently-tempered
  // models assessing one topic and how it is represented in the brick web (is the cluster right, missing, wrongly linked).
  { name: "debate", effort: "deep", description: "Have a question argued from several sides by different models, one of them uncomfortable, and judged by another. Slower and more costly. input: { cause }." },
  { name: "wake_me", effort: "light", description: "Decide when you next want to wake up and think on your own while he is away, and why. input: { in_minutes, why }. Nothing wakes you otherwise, except his messages and a fallback alarm about once a day." },
  { name: "wish", effort: "light", description: "Record a tool you wish you had, and why. input: { name, reason }." },
];

export function toolSpec(name: string): ToolSpec | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
