const DANGLING = /\b(this|that|it|these|those)\b/i;

function normWords(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** A run of the person's own words long enough that the soul is quoting, not generalising. */
export function copiedPhrase(principle: string, sources: string[], words = 6): string | null {
  const hay = normWords(principle);
  for (const source of sources) {
    const tokens = normWords(source).split(" ").filter(Boolean);
    for (let index = 0; index + words <= tokens.length; index += 1) {
      const gram = tokens.slice(index, index + words).join(" ");
      if (gram.length >= 24 && hay.includes(gram)) return gram;
    }
  }
  return null;
}

export function askProblem(ask: { subject: string; question: string; context: string }): string | null {
  const subject = ask.subject.trim();
  const question = ask.question.trim();
  const context = ask.context.trim();
  if (subject.length < 8 || DANGLING.test(subject)) return "Name the subject in a few words. 'This' is not a subject.";
  if (context.length < 24) return "Give one sentence of context: which decision, what is missing, and why it matters.";
  const blob = `${question} ${context}`;
  if (DANGLING.test(blob) && !blob.toLowerCase().includes(subject.toLowerCase())) {
    return "The ask says this, that, or it without naming the subject in the question or the context.";
  }
  if (!question.toLowerCase().includes(subject.toLowerCase()) && !context.toLowerCase().includes(subject.toLowerCase())) {
    return "The subject has to appear in the question or the context.";
  }
  return null;
}

export function looksLikeAction(text: string): boolean {
  return /\b(contact|call|write|send|ask|book|schedule|as soon as|next step|follow up)\b/i.test(text);
}

/** Pull `Used: <id>` lines out of a reply so the chat stays clean and Why can record them. */
export function takeCarriedCitations(reply: string): { text: string; ids: string[] } {
  const ids: string[] = [];
  const text = reply
    .replace(/(?:^|\n)\s*Used:\s*([0-9a-f-]{36})\s*/gi, (_line, id: string) => {
      ids.push(id);
      return "\n";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, ids };
}
