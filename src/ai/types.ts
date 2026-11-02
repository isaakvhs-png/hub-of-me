import type { Role } from "../types.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiRequest {
  role: Role;
  system: string;
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  /** Ask Anthropic to return one JSON object through tool use. */
  structured?: boolean;
  /** Set by the debate runner so two debaters can be given different models. */
  debaterIndex?: number;
  /** When the paid budget is nearly gone, a debater may use Flash-Lite. */
  allowFreeLite?: boolean;
  /** How hard this call is. The router picks a model from it when the provider is not mock. */
  effort?: "light" | "conversation" | "deep";
  images?: { mediaType: string; base64: string }[];
  /** Let the model search the web itself (Anthropic server-side search). Sources come back in the text. */
  webSearch?: boolean;
  /** Mark the system prompt as cacheable: repeated steps of one turn then read it at a fraction of the price. */
  cacheSystem?: boolean;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  webSearches?: number;
}

export interface AiResult {
  text: string;
  usage: ProviderUsage;
  provider: string;
  model: string;
  durationMs: number;
  inputChars: number;
  stopReason: string | null;
}

export function usageIsReal(usage: Partial<ProviderUsage> | undefined): usage is ProviderUsage {
  if (!usage) return false;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  return typeof input === "number" && typeof output === "number" && Number.isInteger(input) && Number.isInteger(output) && input >= 0 && output >= 0;
}
