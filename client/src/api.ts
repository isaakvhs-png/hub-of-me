export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const init: RequestInit = { method: opts.method ?? (opts.body || opts.form ? "POST" : "GET"), credentials: "include" };
  if (opts.form) init.body = opts.form;
  else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers = { "content-type": "application/json" }; }
  const r = await fetch(`/api${path}`, init);
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new ApiError(r.status, (data && data.error) || `Request failed (${r.status})`);
  return data as T;
}

export const COLOURS: Record<string, string> = { isaak: "var(--white)", web: "var(--cyan)", self: "var(--amber)", session: "var(--green)" };
export const ORIGIN_NAME: Record<string, string> = { isaak: "from you", web: "from the web", self: "its own thoughts", session: "from work sessions" };
