export const TRACE_DESTINATIONS = ["picture", "world", "followup", "soul", "debate", "behavior", "memory"] as const;
export type TraceDestination = (typeof TRACE_DESTINATIONS)[number];

export interface LocatedSpan {
  start: number;
  end: number;
  phrase: string;
  destination: string;
  label: string;
  situations: string;
}

/** Turn model phrases into offsets in the source text. The same phrase can land once and carry several destinations. Phrases that are not actually present are dropped. */
export function locateSpans(text: string, spans: { phrase: string; destination: string; label: string; situations?: string }[]): LocatedSpan[] {
  const found: LocatedSpan[] = [];
  const placed = new Map<string, { start: number; end: number }>();
  const seen = new Set<string>();
  const haystack = text.toLowerCase();
  for (const span of spans) {
    const phrase = span.phrase.trim();
    const label = span.label.trim();
    if (!phrase || !label) continue;
    const key = phrase.toLowerCase();
    let loc = placed.get(key);
    if (!loc) {
      const start = haystack.indexOf(key);
      if (start < 0) continue;
      loc = { start, end: start + phrase.length };
      placed.set(key, loc);
    }
    const slot = `${loc.start}:${span.destination}`;
    if (seen.has(slot)) continue;
    seen.add(slot);
    found.push({
      start: loc.start,
      end: loc.end,
      phrase: text.slice(loc.start, loc.end),
      destination: span.destination,
      label,
      situations: span.situations?.trim() ?? "",
    });
  }
  return found;
}

export function mindNoteProblem(note: {
  note: string;
  coversPeter: boolean;
  coversWorld: boolean;
  coversItself: boolean;
  quiet: string[];
  quietWhy?: string;
}): string | null {
  if (!note.note.trim()) return "The note is empty.";
  const parts = [
    ["peter", note.coversPeter],
    ["world", note.coversWorld],
    ["itself", note.coversItself],
  ] as const;
  for (const [name, covered] of parts) {
    if (covered) continue;
    if (!note.quiet.includes(name)) return `Say something about ${name}, or say why that part is quiet.`;
  }
  if (note.quiet.length > 0 && !note.quietWhy?.trim()) return "Say why the quiet part is quiet.";
  return null;
}
