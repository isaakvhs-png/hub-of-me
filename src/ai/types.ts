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
  /** Set by the debate runner so two debaters can be given different models. */
  debaterIndex?: number;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

export interface AiResult {
  text: string;
  usage: ProviderUsage;
  provider: string;
  model: string;
  durationMs: number;
  inputChars: number;
}

export function usageIsReal(usage: Partial<ProviderUsage> | undefined): usage is ProviderUsage {
  if (!usage) return false;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  return typeof input === "number" && typeof output === "number" && Number.isInteger(input) && Number.isInteger(output) && input >= 0 && output >= 0;
}
