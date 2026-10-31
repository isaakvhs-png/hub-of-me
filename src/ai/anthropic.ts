import { UsageMissingError } from "../errors.js";
import type { AiRequest, ProviderUsage } from "./types.js";
import { usageIsReal } from "./types.js";

interface AnthropicBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  stop_reason?: string;
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
): Promise<{ text: string; usage: ProviderUsage; stopReason: string | null }> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 2000,
    system: req.system,
    messages: req.messages.map((message) => ({ role: message.role, content: message.content })),
  };
  if (req.structured) {
    body.tools = [
      {
        name: "submit_result",
        description: "Return the task result as one JSON object.",
        input_schema: { type: "object", additionalProperties: true },
      },
    ];
    body.tool_choice = { type: "tool", name: "submit_result" };
  }
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
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
  const blocks = json.content ?? [];
  const tool = blocks.find((block) => block.type === "tool_use" && block.input && typeof block.input === "object");
  const text = tool
    ? JSON.stringify(tool.input)
    : blocks
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text)
        .join("\n")
        .trim();
  const stopReason = json.stop_reason ?? null;
  if (!text && stopReason !== "max_tokens") throw new Error("Anthropic response had no text.");
  return { text, usage, stopReason };
}
