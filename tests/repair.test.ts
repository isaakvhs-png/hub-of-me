import { afterEach, describe, expect, it } from "vitest";
import { completeJson } from "../src/ai/tracked.js";
import { Router } from "../src/ai/router.js";
import { loadVisibleNotes } from "../src/pipeline/context.js";
import { runReflection } from "../src/pipeline/debate.js";
import { criticSchema } from "../src/schemas.js";
import { getDebate, getSettings, getSoul, insertDebate, insertNote, insertSoulVersion, listDebates, listSoulVersions, settleStuckDebates, startJob, finishJob, updateSettings } from "../src/repo.js";
import { SEED_SOUL } from "../src/soul-seed.js";
import { mergeSoulSections, missingSoulSections, restoreCorruptedSouls } from "../src/soul.js";
import { fresh } from "./helpers.js";

const savedKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (savedKey == null) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

describe("repairs from the live diagnostics", () => {
  it("does not accept JSON cut off at max_tokens and retries with a higher limit", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-secret-value";
    const { db, user } = await fresh();
    const settings = await getSettings(db, user.id);
    const bodies: { max_tokens?: number; tools?: unknown }[] = [];
    let calls = 0;
    const ai = new Router(
      { ...settings, provider: "anthropic" },
      {
        fetchImpl: async (_url, init) => {
          calls += 1;
          const body = JSON.parse(String(init?.body)) as { max_tokens?: number; tools?: unknown };
          bodies.push(body);
          if (calls === 1) {
            return new Response(
              JSON.stringify({
                stop_reason: "max_tokens",
                content: [{ type: "text", text: '{"ok": true, "problem": "cut' }],
                usage: { input_tokens: 10, output_tokens: 2000 },
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              stop_reason: "tool_use",
              content: [{ type: "tool_use", name: "submit_result", input: { ok: true, problem: "" } }],
              usage: { input_tokens: 12, output_tokens: 30 },
            }),
            { status: 200 },
          );
        },
      },
    );
    const parsed = await completeJson(
      db,
      user.id,
      ai,
      { role: "critic", system: "Return JSON.", messages: [{ role: "user", content: "Check it." }] },
      criticSchema,
      {},
    );
    expect(parsed).toEqual({ ok: true, problem: "" });
    expect(calls).toBe(2);
    expect(bodies[0].max_tokens).toBe(2000);
    expect(bodies[1].max_tokens).toBe(4000);
    expect(bodies[0].tools).toBeTruthy();
    expect(bodies[1].tools).toBeTruthy();
    await db.close();
  });

  it("marks a debate failed when a later JSON call breaks, and settles one left running", async () => {
    const { db, user, ai, mock } = await fresh();
    mock.invalidOnRole.judge = 5;
    const result = await runReflection(db, ai, user.id, { cause: "A filed note was flagged." });
    expect("error" in result).toBe(true);
    const debates = await listDebates(db, user.id);
    expect(debates).toHaveLength(1);
    expect(debates[0].status).toBe("failed");
    expect(String(debates[0].whyWon)).toMatch(/json|invalid|not json/i);

    const jobId = await startJob(db, user.id, "debate", "Stuck on purpose.");
    await finishJob(db, jobId, "failed", "Expected ',' or ']' after array element in JSON at position 4393");
    const stuck = await insertDebate(db, { userId: user.id, question: "Left running?", judgeModel: "mock-judge", jobId, mockEra: true });
    expect(await settleStuckDebates(db)).toBe(1);
    const row = await getDebate(db, user.id, stuck);
    expect(row?.status).toBe("failed");
    expect(String(row?.whyWon)).toMatch(/4393/);
    expect(await settleStuckDebates(db)).toBe(0);
    await db.close();
  });

  it("merges soul sections and restores version 1 without dropping history", async () => {
    const merged = mergeSoulSections(SEED_SOUL, [{ heading: "Last reflection", body: "This matters most now, because the dump is open, at the cost of a new thread." }]);
    expect(missingSoulSections(merged)).toEqual([]);
    expect(merged).toMatch(/How this system thinks/);
    expect(merged).toMatch(/Personality/);
    expect(merged).toMatch(/This matters most now/);

    const { db, user } = await fresh();
    const original = await getSoul(db, user.id);
    await insertSoulVersion(db, {
      userId: user.id,
      version: 2,
      content: "## Last reflection\nThis matters most now, because x, at the cost of y.\n",
      reason: "Mock reflection replaced the document.",
      causingMessageId: null,
      createdByRole: "reflection",
    });
    expect(await restoreCorruptedSouls(db)).toBe(1);
    const current = await getSoul(db, user.id);
    expect(current?.version).toBe(3);
    expect(current?.reason).toBe("Restored after mock-era overwrite");
    expect(current?.content).toBe(original?.content);
    expect(await listSoulVersions(db, user.id)).toHaveLength(3);
    expect(await restoreCorruptedSouls(db)).toBe(0);
    await db.close();
  });

  it("keeps mock-era notes out of evidence once a real provider is selected", async () => {
    const { db, user } = await fresh();
    const settings = await getSettings(db, user.id);
    const mockNote = await insertNote(db, user.id, {
      folderId: null,
      type: "idea",
      title: "Mock filing",
      body: "Written while the provider was mock.",
      status: "unexplored",
      forNowExpiresAt: null,
      reason: "Filed from a dump.",
      causingMessageId: null,
      source: "filing",
      mockEra: true,
    });
    const realNote = await insertNote(db, user.id, {
      folderId: null,
      type: "idea",
      title: "Real filing",
      body: "Written after the switch.",
      status: "unexplored",
      forNowExpiresAt: null,
      reason: "Filed from a dump.",
      causingMessageId: null,
      source: "filing",
      mockEra: false,
    });
    const asMock = await loadVisibleNotes(db, user.id, settings);
    expect(asMock.notes.map((note) => note.id)).toContain(mockNote.id);
    await updateSettings(db, { ...settings, provider: "anthropic" });
    const asReal = await loadVisibleNotes(db, user.id, await getSettings(db, user.id));
    expect(asReal.notes.map((note) => note.id)).not.toContain(mockNote.id);
    expect(asReal.notes.map((note) => note.id)).toContain(realNote.id);
    expect(mockNote.mockEra).toBe(true);
    await db.close();
  });
});
