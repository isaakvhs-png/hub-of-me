import { describe, expect, it } from "vitest";
import { anthropicComplete } from "../src/ai/anthropic.js";
import { geminiComplete } from "../src/ai/gemini.js";
import { Router } from "../src/ai/router.js";
import { trackedComplete } from "../src/ai/tracked.js";
import { UsageMissingError } from "../src/errors.js";
import { costUsdCents, toEurCents } from "../src/prices.js";
import { getSettings, listUsage, setBudget, updateSettings } from "../src/repo.js";
import { fresh } from "./helpers.js";

describe("usage accounting", () => {
  it("prices reported tokens and converts with the configured rate", () => {
    const usd = costUsdCents("priced-test", { inputTokens: 500_000, outputTokens: 0 });
    expect(usd).toBe(150);
    expect(toEurCents(150, 0.8959)).toBeCloseTo(134.385, 5);
    const haiku = costUsdCents("claude-haiku-5-5", { inputTokens: 150_000, outputTokens: 1_000 });
    expect(haiku).toBeCloseTo((150_000 / 1_000_000) * 0.5 * 100 + (1_000 / 1_000_000) * 2.5 * 100, 6);
    const small = costUsdCents("claude-haiku-5-5", { inputTokens: 6915, outputTokens: 2000 });
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(1);
    expect(small).toBeCloseTo((6915 / 1_000_000) * 0.1 * 100 + (2000 / 1_000_000) * 0.5 * 100, 6);
    expect(toEurCents(small ?? 0, 0.8959)).toBeGreaterThan(0);
    expect(costUsdCents("missing-model", { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });

  it("copies provider usage and refuses to invent it", async () => {
    const { db, user, ai } = await fresh();
    await trackedComplete(db, user.id, ai, { role: "filing", system: "ROLE", messages: [{ role: "user", content: "hello" }] });
    const [row] = await listUsage(db, user.id, "2000-01-01T00:00:00.000Z");
    expect(row.inputTokens).toBe(80);
    expect(row.outputTokens).toBe(36);
    expect(row.model).toBe("mock-cheap");
    const settings = await getSettings(db, user.id);
    const unpriced = new Router({ ...settings, provider: "anthropic", cheapModel: "anthropic:not-a-real-model" }, {
      fetchImpl: async () => {
        throw new Error("network should not be called");
      },
    });
    await expect(unpriced.complete({ role: "filing", system: "x", messages: [{ role: "user", content: "y" }] })).rejects.toThrow(/list price/);
    await expect(
      anthropicComplete({ role: "filing", model: "claude-haiku-5-5", system: "s", messages: [] }, "key", async () => new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }] }), { status: 200 })),
    ).rejects.toBeInstanceOf(UsageMissingError);
    const gemini = await geminiComplete(
      { role: "filing", model: "gemini-2.5-flash", system: "s", messages: [{ role: "user", content: "q" }] },
      "key",
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "answer" }] } }],
            usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, thoughtsTokenCount: 3 },
          }),
          { status: 200 },
        ),
    );
    expect(gemini.usage).toEqual({ inputTokens: 11, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
    await db.close();
  });

  it("stops calling once the monthly cap is spent", async () => {
    const { db, user, ai } = await fresh();
    await setBudget(db, user.id, 100);
    const settings = await getSettings(db, user.id);
    await updateSettings(db, {
      ...settings,
      priceOverrides: { "mock-cheap": { inputPerMTokUsd: 1_000_000, outputPerMTokUsd: 1_000_000 } },
    });
    const priced = new Router(await getSettings(db, user.id), {});
    await trackedComplete(db, user.id, priced, { role: "filing", system: "s", messages: [{ role: "user", content: "one" }] });
    const [first] = await listUsage(db, user.id, "2000-01-01T00:00:00.000Z");
    expect(first.inputTokens).toBe(80);
    expect(first.costEurCents).toBeGreaterThan(100);
    await expect(
      trackedComplete(db, user.id, new Router(await getSettings(db, user.id), {}), {
        role: "filing",
        system: "s",
        messages: [{ role: "user", content: "two" }],
      }),
    ).rejects.toThrow(/cap/i);
    const rows = await listUsage(db, user.id, "2000-01-01T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    await db.close();
  });
});
