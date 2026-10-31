import { afterEach, describe, expect, it } from "vitest";
import { resolveRoleModel, Router } from "../src/ai/router.js";
import { createDb, migrate } from "../src/db.js";
import { getSettings, updateSettings } from "../src/repo.js";
import { applyEnvProvider, ensureUser } from "../src/seed.js";

const KEYS = ["AI_PROVIDER", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] == null) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function clearProviderEnv(): void {
  for (const key of KEYS) delete process.env[key];
}

describe("provider selection", () => {
  it("adopts a trimmed AI_PROVIDER over the first-boot mock and does not hide a failed real call", async () => {
    clearProviderEnv();
    const db = await createDb({ memory: true });
    await migrate(db);
    const user = await ensureUser(db, { email: "peter@local", password: "hub-of-me", name: "Peter", provider: "mock" });
    expect((await getSettings(db, user.id)).provider).toBe("mock");

    process.env.AI_PROVIDER = " Anthropic ";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-secret-value";
    await applyEnvProvider(db);
    const settings = await getSettings(db, user.id);
    expect(settings.provider).toBe("anthropic");
    expect(resolveRoleModel(settings, { role: "debater", debaterIndex: 0 }).provider).toBe("anthropic");
    expect(resolveRoleModel(settings, { role: "judge" }).model).not.toMatch(/^mock/);
    expect(resolveRoleModel(settings, { role: "conversation" }).model).toBe("claude-haiku-5-5");

    const failing = new Router(settings, {
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401, headers: { "content-type": "application/json" } }),
    });
    await expect(
      failing.complete({ role: "conversation", system: "Stay concrete.", messages: [{ role: "user", content: "Hello." }] }),
    ).rejects.toThrow(/invalid x-api-key/);

    const succeeding = new Router(settings, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "A real reply, not a mock debater." }],
            usage: { input_tokens: 12, output_tokens: 6 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const result = await succeeding.complete({ role: "conversation", system: "Stay concrete.", messages: [{ role: "user", content: "Hello." }] });
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-haiku-5-5");
    expect(result.text).toBe("A real reply, not a mock debater.");

    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      succeeding.complete({ role: "conversation", system: "Stay concrete.", messages: [{ role: "user", content: "Hello." }] }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
    await db.close();
  });

  it("leaves the stored provider alone when AI_PROVIDER is unset", async () => {
    clearProviderEnv();
    const db = await createDb({ memory: true });
    await migrate(db);
    const user = await ensureUser(db, { email: "peter@local", password: "hub-of-me", name: "Peter", provider: "mock" });
    const current = await getSettings(db, user.id);
    await updateSettings(db, { ...current, provider: "gemini" });
    await applyEnvProvider(db);
    expect((await getSettings(db, user.id)).provider).toBe("gemini");
    await db.close();
  });
});
