/**
 * How a Claude plan or API failure should be read (plain words for the models panel).
 *
 * Anthropic and Claude Code treat these as different things:
 * - Out of allowance: "You've hit your session/weekly/Sonnet/Opus limit · resets …", a rejected
 *   rate_limit_event, billing_error, "out of extra usage". This is the plan's quota. Session and
 *   weekly limits apply to every Claude model; a Sonnet or Opus limit applies only to that family
 *   (Haiku can still run).
 * - Overloaded: HTTP 529, overloaded_error, "high demand", "at capacity", "Server is temporarily
 *   limiting requests (not your usage limit)". This is their side, temporary, and does not count
 *   against the plan's quota.
 * - Anything else is just a failed call.
 *
 * The old catch-all /limit|rate|quota|usage/ would treat "not your usage limit" as allowance, and
 * would miss "overloaded" / "high demand" — so those never set planLimited(), and every later call
 * retried the plan and failed again. Overloaded must stay off the allowance timer (retrying after
 * a short wait is right). Allowance text must set the timer, and a Sonnet/Opus limit must not
 * block Haiku.
 */

export type ClaudeFailureKind = "limited" | "overloaded" | "other";
export type ClaudeLimitScope = "plan" | "sonnet" | "opus" | "haiku";

export interface ClaudeFailure {
  kind: ClaudeFailureKind;
  /** For a limit: the whole plan (session/weekly) or one model family. Ignored for other kinds. */
  scope: ClaudeLimitScope;
  /** When the allowance comes back, if the error said so; otherwise null. */
  resetsAt: number | null;
  /** One short line for the panel, in plain words. */
  label: string;
}

const ZONE = "Europe/Amsterdam";

export class ClaudeOverloadedError extends Error {
  readonly kind = "overloaded" as const;
}

export function modelFamily(model: string): ClaudeLimitScope {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "plan";
}

const OVERLOADED = /529|overloaded(?:_error)?|high demand|at capacity|temporarily (?:at capacity|overloaded|limiting requests)|not your usage limit/i;
const HIT_LIMIT = /you(?:['’]ve| have) hit your\s+(session|weekly|opus|sonnet|haiku)\s+limit/i;
const ALLOWANCE = /out of extra usage|out of (?:your )?allowance|billing_error|billing error|\bquota (?:exceeded|exhausted|reached)\b|\brate_limit_error\b|error['":\s]+rate_limit\b/i;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function amsterdamOffset(atMs: number): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "shortOffset" })
    .formatToParts(new Date(atMs))
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
  const m = name.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!m) return "+01:00";
  return `${m[1]}${pad(Number(m[2]))}:${pad(Number(m[3] ?? 0))}`;
}

function amsterdamParts(atMs: number): { year: number; month: number; day: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
      .formatToParts(new Date(atMs))
      .map((p) => [p.type, p.value]),
  );
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: Math.max(0, weekdays.indexOf(parts.weekday)),
  };
}

function amsterdamAt(year: number, month: number, day: number, hour: number, minute: number, nearMs: number): number {
  const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${amsterdamOffset(nearMs)}`;
  return new Date(iso).getTime();
}

function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const utc = Date.UTC(year, month - 1, day + days);
  const d = new Date(utc);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Read "resets 3:45pm", "resets 14:00", "resets Mon 12:00am" as a time in Europe/Amsterdam. */
export function parseResetsAt(text: string, nowMs = Date.now()): number | null {
  const iso = text.match(/resets\s+(\d{4}-\d{2}-\d{2}T[^\s,·]+)/i);
  if (iso) {
    const t = new Date(iso[1]).getTime();
    return Number.isNaN(t) ? null : t;
  }
  const m = text.match(/resets\s+(?:(\w{3})\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return null;
  const[, dowRaw, hhRaw, mmRaw, ap] = m;
  let hour = Number(hhRaw);
  const minute = Number(mmRaw);
  if (ap) {
    const pm = ap.toLowerCase() === "pm";
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  const now = amsterdamParts(nowMs);
  let y = now.year, mo = now.month, d = now.day;
  if (dowRaw) {
    const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const want = weekdays.indexOf(dowRaw.slice(0, 3).toLowerCase());
    if (want >= 0) {
      let ahead = (want - now.weekday + 7) % 7;
      if (ahead === 0) {
        const today = amsterdamAt(y, mo, d, hour, minute, nowMs);
        if (today <= nowMs) ahead = 7;
      }
      ({ year: y, month: mo, day: d } = addDays(y, mo, d, ahead));
    }
  }
  let at = amsterdamAt(y, mo, d, hour, minute, nowMs);
  if (!dowRaw && at <= nowMs) {
    ({ year: y, month: mo, day: d } = addDays(y, mo, d, 1));
    at = amsterdamAt(y, mo, d, hour, minute, nowMs);
  }
  return Number.isNaN(at) ? null : at;
}

/** Calendar day in Amsterdam, `YYYY-MM-DD`, so a reset can say whether it is today. */
export function amsterdamDayKey(ms: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** A clock in Amsterdam, `HH:MM`. The models panel adds the weekday itself when the reset is another day. */
export function clockInAmsterdam(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function limitedLabel(scope: ClaudeLimitScope, which: string, resetsAt: number | null): string {
  const who = scope === "plan"
    ? (which === "weekly" ? "the weekly allowance" : which === "session" ? "the session allowance" : "allowance")
    : `the ${scope} allowance`;
  if (resetsAt) return `out of ${who} until ${clockInAmsterdam(resetsAt)}`;
  return `out of ${who}`;
}

/**
 * Classify the text the SDK or API actually returned. Overloaded is never treated as allowance.
 * A "not your usage limit" throttle is overloaded (their side), not a plan limit.
 */
export function classifyClaudeFailure(text: string, nowMs = Date.now()): ClaudeFailure {
  const why = String(text ?? "").trim();
  if (!why) return { kind: "other", scope: "plan", resetsAt: null, label: "the call failed" };

  const hit = why.match(HIT_LIMIT);
  // Allowance wording wins over a sentence that also happens to mention demand.
  if (hit) {
    const which = hit[1].toLowerCase();
    const scope: ClaudeLimitScope = which === "opus" || which === "sonnet" || which === "haiku" ? which : "plan";
    const resetsAt = parseResetsAt(why, nowMs);
    return { kind: "limited", scope, resetsAt, label: limitedLabel(scope, which, resetsAt) };
  }
  if (OVERLOADED.test(why)) {
    return { kind: "overloaded", scope: "plan", resetsAt: null, label: "Claude is overloaded (temporary, their side)" };
  }
  if (ALLOWANCE.test(why)) {
    const scope: ClaudeLimitScope = /\bopus\b/i.test(why) ? "opus" : /\bsonnet\b/i.test(why) ? "sonnet" : /\bhaiku\b/i.test(why) ? "haiku" : "plan";
    const resetsAt = parseResetsAt(why, nowMs);
    return { kind: "limited", scope, resetsAt, label: limitedLabel(scope, scope === "plan" ? "allowance" : scope, resetsAt) };
  }
  return { kind: "other", scope: "plan", resetsAt: null, label: why.slice(0, 200) };
}
