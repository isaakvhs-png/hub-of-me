import type { Db } from "../db.js";
import { id } from "../ids.js";
import { hashPassword } from "../password.js";
import { SEED_SOUL } from "../soul-seed.js";
import { iso, sid } from "./store.js";
import type { Ctx } from "./steps.js";

/** Kept from before the rebuild: users, sign-in sessions, the provider setting, the soul's Nature lines and boundaries, the calendar. */

export interface User { id: string; email: string; name: string }

export async function getUserByEmail(db: Db, email: string): Promise<(User & { passwordHash: string }) | null> {
  const r = await db.query(`SELECT * FROM users WHERE email=$1`, [email.toLowerCase()]);
  const row = r.rows[0];
  return row ? { id: String(row.id), email: String(row.email), name: String(row.name), passwordHash: String(row.password_hash) } : null;
}

export async function getUser(db: Db, userId: string): Promise<User | null> {
  const r = await db.query(`SELECT id, email, name FROM users WHERE id=$1`, [userId]);
  const row = r.rows[0];
  return row ? { id: String(row.id), email: String(row.email), name: String(row.name) } : null;
}

export async function listUserIds(db: Db): Promise<string[]> {
  const r = await db.query<{ id: string }>(`SELECT id FROM users ORDER BY created_at`);
  return r.rows.map((row) => String(row.id));
}

export async function createSession(db: Db, userId: string, tokenHash: string, expiresAt: string): Promise<void> {
  await db.query(`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)`, [id(), userId, tokenHash, expiresAt]);
}

export async function userIdForToken(db: Db, tokenHash: string): Promise<string | null> {
  const r = await db.query(`SELECT user_id, expires_at FROM sessions WHERE token_hash=$1`, [tokenHash]);
  const row = r.rows[0];
  if (!row || new Date(iso(row.expires_at)).getTime() < Date.now()) return null;
  return String(row.user_id);
}

export async function expireSession(db: Db, tokenHash: string): Promise<void> {
  await db.query(`UPDATE sessions SET expires_at=now() WHERE token_hash=$1`, [tokenHash]);
}

export async function setPasswordHash(db: Db, userId: string, hash: string): Promise<void> {
  await db.query(`UPDATE users SET password_hash=$2 WHERE id=$1`, [userId, hash]);
}

/** The one account, from USER_EMAIL / USER_PASSWORD / USER_NAME (rewritten in place on every start when both are set). */
export async function ensureAccount(db: Db): Promise<User> {
  const email = (process.env.USER_EMAIL?.trim() || "isaak@local").toLowerCase();
  const password = process.env.USER_PASSWORD?.trim() || "hub-of-me";
  const rawName = process.env.USER_NAME?.trim() || "Isaak";
  const name = rawName === rawName.toUpperCase() ? rawName.charAt(0) + rawName.slice(1).toLowerCase() : rawName;
  const users = await db.query(`SELECT id FROM users ORDER BY created_at`);
  if (users.rows.length === 1 && process.env.USER_EMAIL && process.env.USER_PASSWORD) {
    const userId = String(users.rows[0].id);
    await db.query(`UPDATE users SET email=$2, name=$3, password_hash=$4 WHERE id=$1`, [userId, email, name, await hashPassword(password)]);
    await ensureSoul(db, userId);
    return { id: userId, email, name };
  }
  const existing = await getUserByEmail(db, email);
  if (existing) { await ensureSoul(db, existing.id); return existing; }
  if (users.rows.length >= 1) {
    const userId = String(users.rows[0].id);
    const user = await getUser(db, userId);
    await ensureSoul(db, userId);
    return user!;
  }
  const userId = id();
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)`, [userId, email, name, await hashPassword(password)]);
  await db.query(
    `INSERT INTO settings (user_id, provider, cheap_model, strong_model, judge_model, alternate_model) VALUES ($1,$2,'','','','') ON CONFLICT DO NOTHING`,
    [userId, providerFromEnv() ?? "mock"],
  );
  await ensureSoul(db, userId);
  return { id: userId, email, name };
}

async function ensureSoul(db: Db, userId: string): Promise<void> {
  const r = await db.query(`SELECT 1 FROM soul_versions WHERE user_id=$1 LIMIT 1`, [userId]);
  if (r.rows.length) return;
  await db.query(`INSERT INTO soul_versions (id, user_id, version, content, reason, created_by_role) VALUES ($1,$2,1,$3,$4,'seed')`,
    [id(), userId, SEED_SOUL, "Opening draft: Isaak's Nature lines and boundaries."]);
}

function providerFromEnv(): "mock" | "anthropic" | "gemini" | null {
  const raw = process.env.AI_PROVIDER?.trim().toLowerCase();
  return raw === "mock" || raw === "anthropic" || raw === "gemini" ? raw : null;
}

/** mock runs everything with the scripted model (the bench, local dev); anything else is the live route. */
export async function providerFor(db: Db, userId: string): Promise<"mock" | "live"> {
  const env = providerFromEnv();
  if (env) return env === "mock" ? "mock" : "live";
  const r = await db.query<{ provider: string }>(`SELECT provider FROM settings WHERE user_id=$1`, [userId]);
  return (r.rows[0]?.provider ?? "mock") === "mock" ? "mock" : "live";
}

/** The protected part of the soul: Isaak's Nature lines and the boundaries. Only he changes them. */
export async function natureAndBoundaries(ctx: Ctx): Promise<{ nature: string; boundaries: string }> {
  const r = await ctx.db.query<{ content: string }>(`SELECT content FROM soul_versions WHERE user_id=$1 AND archived_at IS NULL ORDER BY version DESC LIMIT 1`, [ctx.userId]);
  const content = r.rows[0]?.content ?? SEED_SOUL;
  return { nature: sectionBody(content, "Nature") || sectionBody(SEED_SOUL, "Nature"), boundaries: sectionBody(content, "Boundaries") || sectionBody(SEED_SOUL, "Boundaries") };
}

/** The body of one "## Heading" section of the soul. */
export function sectionBody(content: string, heading: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) if (/^##\s+/.test(lines[i])) { end = i; break; }
  return lines.slice(start + 1, end).join("\n").trim();
}

// ---------- calendar (kept as is) ----------

export interface CalEvent { id: string; title: string; startsAt: string; endsAt: string; allDay: boolean; why: string; source: string }

export async function listCalendar(ctx: Ctx, fromIso: string, toIso: string): Promise<CalEvent[]> {
  const r = await ctx.db.query(`SELECT * FROM calendar_events WHERE user_id=$1 AND archived_at IS NULL AND starts_at < $3 AND ends_at > $2 ORDER BY starts_at`, [ctx.userId, fromIso, toIso]);
  return r.rows.map((row) => ({ id: String(row.id), title: String(row.title), startsAt: iso(row.starts_at), endsAt: iso(row.ends_at), allDay: row.all_day === true || row.all_day === "t", why: String(row.why), source: String(row.source) }));
}

export async function addCalendar(ctx: Ctx, e: { title: string; startsAt: string; endsAt?: string; allDay?: boolean; why: string; source: "his" | "its" }): Promise<string> {
  const eventId = sid();
  const start = new Date(e.startsAt);
  if (Number.isNaN(start.getTime())) throw new Error(`Not a time: ${e.startsAt}`);
  const end = e.endsAt ? new Date(e.endsAt) : new Date(start.getTime() + 60 * 60 * 1000);
  await ctx.db.query(`INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, all_day, why, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [eventId, ctx.userId, e.title.slice(0, 200), start.toISOString(), end.toISOString(), e.allDay ?? false, e.why, e.source]);
  return eventId;
}

export async function moveCalendar(ctx: Ctx, eventId: string, startsAt: string, endsAt?: string): Promise<void> {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) throw new Error(`Not a time: ${startsAt}`);
  const end = endsAt ? new Date(endsAt) : new Date(start.getTime() + 60 * 60 * 1000);
  await ctx.db.query(`UPDATE calendar_events SET starts_at=$3, ends_at=$4 WHERE user_id=$1 AND id=$2`, [ctx.userId, eventId, start.toISOString(), end.toISOString()]);
}

export async function archiveCalendar(ctx: Ctx, eventId: string): Promise<void> {
  await ctx.db.query(`UPDATE calendar_events SET archived_at=now() WHERE user_id=$1 AND id=$2`, [ctx.userId, eventId]);
}
