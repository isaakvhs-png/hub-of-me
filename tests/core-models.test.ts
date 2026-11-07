import { afterEach, describe, expect, it } from "vitest";
import { LiveModels, tierModel } from "../src/core/ai.js";
import { setPlanQueryForTests } from "../src/ai/plan.js";
import { assertCanReachOut, assertNotDelete, assertNotSigningIn } from "../src/boundaries.js";
import { guardSearchQuery } from "../src/privacy.js";
import { isProtected } from "../src/core/workshop.js";

const KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "MODEL_REVIEW"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  setPlanQueryForTests(null);
  for (const k of KEYS) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe("the models (plan route first)", () => {
  it("streams call A's text through the plan, never hands the SDK an API key, and names the model", async () => {
    for (const k of KEYS) delete process.env[k];
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-should-not-be-used";
    let seen: Record<string, unknown> = {};
    setPlanQueryForTests(async function* (params) {
      seen = params.options ?? {};
      for (const t of ["DRAFT:\nx\nREPLY:\nHel", "lo"]) yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } };
      yield { type: "result", subtype: "success", is_error: false, result: "DRAFT:\nx\nREPLY:\nHello", usage: { input_tokens: 10, output_tokens: 5 } };
    });
    const deltas: string[] = [];
    const r = await new LiveModels().call({ task: "callA", tier: "main", system: "s", prompt: "p", onDelta: (t) => deltas.push(t) });
    expect(r.provider).toBe("claude-plan");
    expect(r.model).toBe("claude-sonnet-5-5");
    expect(deltas.join("")).toBe("DRAFT:\nx\nREPLY:\nHello");
    expect(seen.includePartialMessages).toBe(true);
    expect((seen.env as Record<string, unknown>).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("reviews with a different model from the worker", () => {
    delete process.env.MODEL_REVIEW;
    expect(tierModel("review")).not.toBe(tierModel("main"));
  });

  it("fails plainly when no route is set up", async () => {
    for (const k of KEYS) delete process.env[k];
    await expect(new LiveModels().call({ task: "x", tier: "fast", system: "s", prompt: "p" })).rejects.toThrow(/No model is set up/);
  });
});

describe("boundaries and protected parts (code, not judgment)", () => {
  it("never deletes, never signs in, never sends email", () => {
    expect(() => assertNotDelete("delete_brick")).toThrow();
    expect(() => assertNotSigningIn("enter_password")).toThrow();
    expect(() => assertCanReachOut({ channel: "email", explicitYes: true })).toThrow(/read and draft only/);
  });
  it("keeps private details out of web searches", () => {
    expect(guardSearchQuery("someone@example.org").ok).toBe(false);
    expect(guardSearchQuery("+31 6 1234 5678").ok).toBe(false);
    expect(guardSearchQuery("Mangrove Champions Initiative Kenya").ok).toBe(true);
  });
  it("marks requests that touch tests, boundaries, Nature lines or sign-in as protected", () => {
    expect(isProtected("change tests/bench so it passes")).toBe(true);
    expect(isProtected("rewrite the Nature lines")).toBe(true);
    expect(isProtected("relax the boundaries check")).toBe(true);
    expect(isProtected("a hand to read Gmail")).toBe(false);
  });
});
