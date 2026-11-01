import type { Effort } from "../ai/effort.js";

export interface ToolSpec {
  name: string;
  effort: Effort;
  description: string;
}

/** What the entity may choose. Adding one does not change the soul. */
export const TOOLS: ToolSpec[] = [
  { name: "notebook_read", effort: "light", description: "Read the notebook: soul, notes, the picture of him, open to-dos, and the mind note." },
  { name: "notebook_write", effort: "light", description: "Save a note from what he just said. input: { title, body, phrase }. phrase is his words, copied from the message." },
  { name: "mark", effort: "light", description: "Point at a phrase in his message and where it is going. input: { phrase, destination, label }. destination is picture, world, followup, soul, debate, behavior, or memory." },
  { name: "todos", effort: "light", description: "Read the ledger, quietly add an item, or fade one with a reason. input: { action, title, why, owner, taskId, reason }. action is list, remember, or fade." },
  { name: "read_file", effort: "light", description: "Read one attached file. Images and textless PDFs are read by sight. input: { name }." },
  { name: "read_records", effort: "light", description: "Read your own records: thinking sessions, actions, and soul changes. Use this before explaining what you did or why. Do not guess." },
  { name: "search", effort: "light", description: "Look something up on the public web. input: { topic }." },
  { name: "ask", effort: "conversation", description: "Hold a question to raise when it fits. input: { subject, question, context, why, expect }." },
  { name: "debate", effort: "deep", description: "Argue a question, including a side that can challenge the picture of him. input: { cause }." },
  { name: "reflect", effort: "deep", description: "Reflect on a real moment so character can grow. Use this for a correction, not to add a rule. input: { cause }." },
  { name: "wish", effort: "light", description: "Record a tool you wish you had, and why. input: { name, reason }." },
];

export function toolSpec(name: string): ToolSpec | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
