import { describe, expect, it } from "vitest";
import { chooseModel } from "../src/ai/effort.js";

describe("model routing", () => {
  const empty = { usedToday: {}, usedMinute: {} };

  it("uses Flash-Lite for light work and Claude when that quota is gone or the key is missing", () => {
    expect(chooseModel({ effort: "light", gemini: true, anthropic: true, ...empty }).model).toBe("gemini-3.5-flash-lite");
    expect(chooseModel({ effort: "conversation", gemini: true, anthropic: true, ...empty }).model).toBe("claude-haiku-5-5");
    expect(chooseModel({ effort: "deep", gemini: true, anthropic: true, ...empty }).model).toBe("claude-sonnet-5-5");
    expect(chooseModel({
      effort: "light",
      gemini: true,
      anthropic: true,
      usedToday: { "gemini-3.5-flash-lite": 500 },
      usedMinute: {},
    }).model).toBe("claude-haiku-5-5");
    expect(chooseModel({ effort: "light", gemini: false, anthropic: true, ...empty }).why).toMatch(/No Gemini key/);
    expect(() => chooseModel({ effort: "conversation", gemini: true, anthropic: false, ...empty })).toThrow(/ANTHROPIC_API_KEY/);
  });
});
