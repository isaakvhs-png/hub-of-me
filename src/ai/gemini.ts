import { UsageMissingError } from "../errors.js";
import type { AiRequest, ProviderUsage } from "./types.js";

interface GeminiResponse {
  candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  error?: { message?: string };
}

export async function geminiComplete(
  req: AiRequest & { model: string },
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; usage: ProviderUsage; stopReason: string | null }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map((message, index) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [
          { text: message.content },
          ...(index === req.messages.length - 1 ? (req.images ?? []).map((image) => ({ inlineData: { mimeType: image.mediaType, data: image.base64 } })) : []),
        ],
      })),
      generationConfig: { maxOutputTokens: req.maxTokens ?? 2000 },
    }),
  });
  const json = (await response.json()) as GeminiResponse;
  if (!response.ok) {
    throw new Error(json.error?.message || `Gemini request failed (${response.status})`);
  }
  const prompt = json.usageMetadata?.promptTokenCount;
  const candidates = json.usageMetadata?.candidatesTokenCount;
  const thoughts = json.usageMetadata?.thoughtsTokenCount ?? 0;
  if (!Number.isInteger(prompt) || !Number.isInteger(candidates)) {
    throw new UsageMissingError("Gemini response had no token usage. Refusing to estimate.");
  }
  const usage: ProviderUsage = {
    inputTokens: prompt as number,
    outputTokens: (candidates as number) + thoughts,
    cacheReadTokens: json.usageMetadata?.cachedContentTokenCount ?? 0,
    cacheWriteTokens: 0,
  };
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  const finish = json.candidates?.[0]?.finishReason ?? null;
  const stopReason = finish === "MAX_TOKENS" ? "max_tokens" : finish;
  if (!text && stopReason !== "max_tokens") throw new Error("Gemini response had no text.");
  return { text, usage, stopReason };
}
