const COMMITMENT = /this matters most now, because\s+.+,\s+at the cost of\s+.+/i;
const HEDGE = /\bit depends\b|\bon the one hand\b|\bcould go either way\b|\bboth (options|sides) have merit\b|\bit's hard to say\b/i;
const AVERAGE = /\bconsensus\b|\bsplit the difference\b|\bboth equally\b|\baverage of\b|\bmiddle ground\b/i;

export function reflectionRejection(text: string): string | null {
  if (HEDGE.test(text)) return "hedged reflection";
  if (!COMMITMENT.test(text)) return "missing commitment";
  return null;
}

export function judgeRejection(text: string): string | null {
  if (AVERAGE.test(text)) return "averaging is not a verdict";
  if (HEDGE.test(text)) return "hedged verdict";
  return null;
}

export function argumentRejection(text: string): string | null {
  if (HEDGE.test(text)) return "hedged argument";
  return null;
}
