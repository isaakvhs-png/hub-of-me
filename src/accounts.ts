import { id } from "./ids.js";
import { hashPassword, verifyPassword } from "./password.js";
import { db } from "./state.js";

/** Login like the old build (Isaak, 15 Nov: "login just like we have now"): one account from USER_EMAIL / USER_PASSWORD. */
export async function ensureAccount(): Promise<void> {
  const email = (process.env.USER_EMAIL?.trim() || "isaak@local").toLowerCase();
  const password = process.env.USER_PASSWORD?.trim() || "hub-rings";
  const raw = process.env.USER_NAME?.trim() || "Isaak";
  const name = raw === raw.toUpperCase() ? raw.charAt(0) + raw.slice(1).toLowerCase() : raw;
  const r = await db().query<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`);
  if (r.rows[0]) {
    await db().query(`UPDATE users SET email = $2, name = $3, password_hash = $4 WHERE id = $1`, [r.rows[0].id, email, name, await hashPassword(password)]);
    return;
  }
  await db().query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)`, [id(), email, name, await hashPassword(password)]);
}

export async function checkLogin(email: string, password: string): Promise<{ id: string; name: string } | null> {
  const r = await db().query<{ id: string; name: string; password_hash: string }>(`SELECT id, name, password_hash FROM users WHERE email = $1`, [email.trim().toLowerCase()]);
  const row = r.rows[0];
  if (!row || !(await verifyPassword(password, row.password_hash))) return null;
  return { id: row.id, name: row.name };
}

export async function createSession(userId: string, tokenHash: string): Promise<void> {
  await db().query(`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3, now() + interval '30 days')`, [id(), userId, tokenHash]);
}

export async function userForToken(tokenHash: string): Promise<{ id: string; name: string } | null> {
  const r = await db().query<{ id: string; name: string }>(`SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`, [tokenHash]);
  return r.rows[0] ?? null;
}

export async function endSession(tokenHash: string): Promise<void> {
  await db().query(`UPDATE sessions SET expires_at = now() WHERE token_hash = $1`, [tokenHash]);
}
