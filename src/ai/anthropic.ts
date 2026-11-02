import { UsageMissingError } from "../errors.js";
import { isForcedToolChoiceError, rememberForcedToolChoiceRejected, supportsForcedToolChoice } from "./capabilities.js";
import type { AiRequest, ProviderUsage } from "./types.js";
import { usageIsReal } from "./types.js";

const STRUCTURED_HINT = "Call the submit_result tool with one JSON object. If you answer in text, return one JSON object and no other prose.";

interface AnthropicBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    server_tool_use?: { web_search_requests?: number };
  };
  error?: { message?: string };
}

function requestBody(req: AiRequest & { model: string }, forceTool: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 2000,
    system: req.system,
    messages: req.messages.map((message, index) => ({
      role: message.role,
      content: index === req.messages.length - 1 && req.images?.length
        ? [
            { type: "text", text: message.content },
            ...req.images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } })),
          ]
        : message.content,
    })),
  };
  if (req.cacheSystem) body.system = [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }];
  if (req.webSearch) {
    body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
    return body;
  }
  if (!req.structured) return body;
  body.tools = [
    {
      name: "submit_result",
      description: "Return the task result as one JSON object.",
      input_schema: { type: "object", additionalProperties: true },
    },
  ];
  if (forceTool) {
    body.tool_choice = { type: "tool", name: "submit_result" };
    return body;
  }
  body.tool_choice = { type: "auto" };
  if (!req.system.includes("submit_result")) {
    const hinted = `${req.system}\n\n${STRUCTURED_HINT}`;
    body.system = req.cacheSystem ? [{ type: "text", text: hinted, cache_control: { type: "ephemeral" } }] : hinted;
  }
  return body;
}

async function anthropicOnce(
  req: AiRequest & { model: string },
  apiKey: string,
  fetchImpl: typeof fetch,
  forceTool: boolean,
): Promise<{ text: string; usage: ProviderUsage; stopReason: string | null }> {
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody(req, forceTool)),
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
    webSearches: json.usage?.server_tool_use?.web_search_requests ?? 0,
  };
  if (!usageIsReal(usage)) {
    throw new UsageMissingError("Anthropic response had no token usage. Refusing to estimate.");
  }
  const blocks = json.content ?? [];
  const tool = blocks.find((block) => block.type === "tool_use" && block.name === "submit_result" && block.input && typeof block.input === "object");
  if (req.webSearch) {
    // The pages it found, then what it wrote about them: the sources are kept, not only the summary.
    const found: { title: string; url: string }[] = [];
    for (const block of blocks) {
      if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
      for (const item of block.content as { type?: string; url?: string; title?: string }[]) {
        if (item.url && !found.some((entry) => entry.url === item.url)) found.push({ title: item.title ?? item.url, url: item.url });
      }
    }
    const written = blocks.filter((block) => block.type === "text" && block.text).map((block) => block.text).join("").trim();
    const text = `${written}\n\nSOURCES:\n${found.map((entry) => `${entry.title} — ${entry.url}`).join("\n") || "(none returned)"}`;
    return { text, usage: usage as ProviderUsage, stopReason: json.stop_reason ?? null };
  }
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

export async function anthropicComplete(
  req: AiRequest & { model: string },
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; usage: ProviderUsage; stopReason: string | null }> {
  const forceTool = Boolean(req.structured) && supportsForcedToolChoice(req.model);
  try {
    return await anthropicOnce(req, apiKey, fetchImpl, forceTool);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!req.structured || !forceTool || !isForcedToolChoiceError(message)) throw error;
    rememberForcedToolChoiceRejected(req.model);
    return anthropicOnce(req, apiKey, fetchImpl, false);
  }
}
