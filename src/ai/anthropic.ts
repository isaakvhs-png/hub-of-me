import { UsageMissingError } from "../errors.js";
import type { AiRequest, ProviderUsage } from "./types.js";
import { usageIsReal } from "./types.js";

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  error?: { message?: string };
}

export async function anthropicComplete(
  req: AiRequest & { model: string },
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; usage: ProviderUsage }> {
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens ?? 2000,
      system: req.system,
      messages: req.messages.map((message) => ({ role: message.role, content: message.content })),
    }),
  });
  const json = (await response.json()) as AnthropicResponse;
  if (!response.ok) {
    throw new Error(json.error?.message || `Anthropic request failed (${response.status})`);
  }
  const usage: Partial<ProviderUsage> = {
    inputTokens: json.usage?.input_tokens,
    outputTokens: json.usage?.output_tokens,
    cacheWriteTokens: json.usage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: json.usage?.cache_read_input_tokens ?? 0,
  };
  if (!usageIsReal(usage)) {
    throw new UsageMissingError("Anthropic response had no token usage. Refusing to estimate.");
  }
  const text = (json.content ?? [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Anthropic response had no text.");
  return { text, usage };
}
