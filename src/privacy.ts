const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const LONG_DIGITS = /\b\d{10,}\b/;
const GROUPED_DIGITS = /(?:\d[\s().-]*){9,}\d/;
const PASSWORD = /\bpassword\b/i;

function hasPhone(text: string): boolean {
  const digits = text.match(/\d/g)?.length ?? 0;
  if (/\+\d/.test(text) && digits >= 8) return true;
  return LONG_DIGITS.test(text) || GROUPED_DIGITS.test(text);
}

export type SearchGuard = { ok: true; query: string } | { ok: false; reason: string };

/**
 * Web search queries are rejected whole when they carry private material.
 * The query is not rewritten and then sent.
 */
export function guardSearchQuery(query: string, privateFragments: string[] = []): SearchGuard {
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, reason: "empty query" };
  if (EMAIL.test(trimmed)) return { ok: false, reason: "email address" };
  if (hasPhone(trimmed)) return { ok: false, reason: "phone or long number" };
  if (PASSWORD.test(trimmed)) return { ok: false, reason: "password" };
  const lower = trimmed.toLowerCase();
  for (const fragment of privateFragments) {
    const piece = fragment.trim().toLowerCase();
    if (piece.length >= 12 && lower.includes(piece)) {
      return { ok: false, reason: "text from a private note" };
    }
  }
  return { ok: true, query: trimmed };
}

export function containsContactDetail(text: string): boolean {
  return EMAIL.test(text) || hasPhone(text);
}
