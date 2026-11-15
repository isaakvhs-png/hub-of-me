export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiRequest {
  system: string;
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  /** Ask Anthropic to return one JSON object through tool use. */
  structured?: boolean;
  /** Gemini: how much to think before answering (9 Nov: Jarvis spent 5–20 s thinking about a greeting). */
  thinking?: "minimal" | "low";
  images?: { mediaType: string; base64: string }[];
  /** Let the model search the web itself (Anthropic server-side search). Sources come back in the text. */
  webSearch?: boolean;
  /** Streamed text as it is written (the plan route asks the SDK for partial messages). */
  onDelta?: (text: string) => void;
  /** The plan route takes higher numbers first (the chat). */
  priority?: number;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  webSearches?: number;
}

export function usageIsReal(usage: Partial<ProviderUsage> | undefined): usage is ProviderUsage {
  if (!usage) return false;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  return typeof input === "number" && typeof output === "number" && Number.isInteger(input) && Number.isInteger(output) && input >= 0 && output >= 0;
}
