export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...init, headers, credentials: "include" });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new ApiError(data.error || "Request failed.", response.status);
  return data as T;
}
