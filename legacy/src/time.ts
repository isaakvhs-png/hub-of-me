/** Offset of `timeZone` relative to UTC at `date`, in milliseconds. */
export function zoneOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const hour = get("hour") === 24 ? 0 : get("hour");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - date.getTime();
}

/** 00:00 on the first of the month in `timeZone`, as a UTC Date. */
export function startOfMonth(timeZone: string, now = new Date()): Date {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
  });
  const parts = dtf.formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const utcGuess = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const offset = zoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offset);
}

export function zonedParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
  });
  const parts = dtf.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const hour = get("hour") === 24 ? 0 : get("hour");
  return { year: get("year"), month: get("month"), day: get("day"), hour };
}

export function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}
