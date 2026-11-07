import { afterEach, describe, expect, it } from "vitest";
import { Router } from "../src/ai/router.js";
import { createDb, migrate } from "../src/db.js";
import { getSettings, updateSettings } from "../src/repo.js";
import { ensureUser } from "../src/seed.js";
import { completeJson } from "../src/ai/tracked.js";
import { planLimited, planStatus, setPlanQueryForTests } from "../src/ai/plan.js";
import { z } from "zod";

const KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  setPlanQueryForTests(null);
  for (const key of KEYS) { if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key]; }
});

async function setup() {
  for (const key of KEYS) delete process.env[key];
  const db = await createDb({ memory: true });
  await migrate(db);
  const user = await ensureUser(db, { email: "isaak@test", password: "secret", name: "Isaak", provider: "mock" });
  const settings = await updateSettings(db, { ...(await getSettings(db, user.id)), provider: "anthropic" });
  return { db, user, ai: new Router(settings) };
}

describe("the Claude plan route", () => {
  it("answers through the plan when its token is set, never hands the SDK an API key, and costs nothing per call", async () => {
    const { db, user, ai } = await setup();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-should-not-be-used";
    let seen: Record<string, unknown> = {};
    setPlanQueryForTests(async function* (params) {
      seen = params.options ?? {};
      yield { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.12, resetsAt: Math.floor(Date.now() / 1000) + 3600 } };
      yield { type: "result", subtype: "success", is_error: false, result: '{"items":[],"links":[]}', stop_reason: "end_turn", usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    });
    const out = await completeJson(db, user.id, ai, { role: "filing", model: "claude-sonnet-5-5", system: "file it", messages: [{ role: "user", content: "x" }] }, z.object({ items: z.array(z.unknown()), links: z.array(z.unknown()) }), { jobKind: "intake" });
    expect(out.items).toEqual([]);
    expect((seen.env as Record<string, unknown>).ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.tools).toEqual([]);
    const row = (await db.query(`SELECT provider, model, cost_eur_cents, input_tokens FROM usage_records ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(row.provider).toBe("claude-plan");
    expect(Number(row.cost_eur_cents)).toBe(0);
    expect(Number(row.input_tokens)).toBe(1200);
    expect(planStatus()?.utilization).toBe(0.12);
    await db.close();
  });

  it("stops trying the plan when its allowance is used up, and says so instead of guessing", async () => {
    const { ai } = await setup();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    setPlanQueryForTests(async function* () {
      yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: Math.floor(Date.now() / 1000) + 1800 } };
      yield { type: "result", subtype: "error_during_execution", is_error: true, result: "Claude usage limit reached", errors: [], usage: {} };
    });
    await expect(ai.complete({ role: "filing", model: "claude-haiku-5-5", system: "s", messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/allowance|limit/);
    expect(planLimited()).toBe(true);
  });
});
