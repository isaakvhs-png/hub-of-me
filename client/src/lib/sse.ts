export async function readSse(response: Response, onEvent: (event: string, data: Record<string, unknown>) => void): Promise<void> {
  if (!response.ok || !response.body) throw new Error("The stream did not open.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const event = part.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
      const raw = part
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!raw) continue;
      onEvent(event, JSON.parse(raw) as Record<string, unknown>);
    }
  }
}
