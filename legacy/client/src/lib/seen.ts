import { api } from "@/lib/api";

/** Read the last visit, then mark this visit. Callers highlight against the returned time. */
export async function loadSeen(surface: string): Promise<string | null> {
  const data = await api<{ seen: string | null }>(`/api/seen?surface=${encodeURIComponent(surface)}`);
  api("/api/seen", { method: "POST", body: JSON.stringify({ surface }) }).catch(() => undefined);
  return data.seen;
}

export function isFresh(seen: string | null | undefined, at: string | null | undefined): boolean {
  if (!seen || !at) return false;
  return at > seen;
}
