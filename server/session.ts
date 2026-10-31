import { createHash } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

const COOKIE = "hub_session";

export function hashToken(token: string): string {
  const pepper = process.env.SESSION_SECRET ?? "dev-session-secret";
  return createHash("sha256").update(`${pepper}:${token}`).digest("hex");
}

export function readSession(c: Context): string | undefined {
  return getCookie(c, COOKIE);
}

export function writeSession(c: Context, token: string): void {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearSession(c: Context): void {
  deleteCookie(c, COOKIE, { path: "/" });
}
