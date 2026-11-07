import { describe, expect, it } from "vitest";
import { runDump } from "../src/pipeline/dump.js";
import { listDebates, listDebateSides, listNotes, listNoteVersions, listPreferences, listUsage, countNotes, insertFeedback, getSoul } from "../src/repo.js";
import { runReflection } from "../src/pipeline/debate.js";
import { fresh } from "./helpers.js";

describe("mock pipeline", () => {
  it("files a dump, versions it, debates, judges, updates the soul, and counts provider usage", async () => {
    const { db, user, ai, mock } = await fresh();
    const result = await runDump(db, ai, user.id, { text: "I keep meaning to write the chapter and then I don't." });
    expect(result.filingError).toBeNull();
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].status).toBe("unexplored");
    const versions = await listNoteVersions(db, result.notes[0].id);
    expect(versions).toHaveLength(1);
    expect(versions[0].reason).toMatch(/Filed/);
    expect(versions[0].causingMessageId).toBe(result.userMessageId);
    expect(result.reflection && "debateId" in result.reflection).toBe(true);
    if (!result.reflection || !("debateId" in result.reflection)) throw new Error("reflection did not conclude");
    const soul = await getSoul(db, user.id);
    expect(soul?.version).toBe(2);
    expect(soul?.createdByRole).toBe("reflection");
    expect(soul?.content).toMatch(/this matters most now, because/i);
    const debates = await listDebates(db, user.id);
    expect(debates[0].status).toBe("concluded");
    expect(debates[0].whyWon).toBeTruthy();
    expect(debates[0].loserGotRight).toBeTruthy();
    expect(debates[0].commitment).toMatch(/at the cost of/i);
    const sides = await listDebateSides(db, debates[0].id as string);
    expect(sides.some((side) => side.uncomfortable)).toBe(true);
    expect(sides.every((side) => side.model !== "mock-judge")).toBe(true);
    expect(new Set(sides.map((side) => side.model)).size).toBe(sides.length);
    const evidence = sides.map((side) => (side.evidenceNoteIds as string[]).join(","));
    expect(new Set(evidence).size).toBe(evidence.length);
    const usage = await listUsage(db, user.id, "2000-01-01T00:00:00.000Z");
    const judgeCalls = mock.calls.filter((call) => call.role === "judge");
    expect(judgeCalls).toHaveLength(1);
    const judgeText = `${judgeCalls[0].system}\n${judgeCalls[0].messages.map((message) => message.content).join("\n")}`;
    expect(judgeText.toLowerCase()).not.toContain("uncomfortable");
    expect(judgeText).not.toContain("mock-debater");
    expect(judgeText).not.toContain("mock-judge");
    expect(usage).toHaveLength(mock.calls.length);
    for (const row of usage) {
      const expected = mockUsage(row.role);
      expect(row.inputTokens).toBe(expected.inputTokens);
      expect(row.outputTokens).toBe(expected.outputTokens);
      expect(row.priceKnown).toBe(true);
    }
    expect(await countNotes(db, user.id)).toBe(1);
    const sampleId = await insertFeedback(db, user.id, "I don't like this article because it talks down.", "discovery");
    const again = await runReflection(db, ai, user.id, { cause: "Feedback should become a general preference, with the example kept as evidence." });
    expect("debateId" in again).toBe(true);
    const rules = await listPreferences(db, user.id);
    expect(rules).toHaveLength(1);
    expect(rules[0].statement).not.toContain("talks down");
    expect(rules[0].evidenceIds).toContain(sampleId);
    const notes = await listNotes(db, user.id);
    expect(notes).toHaveLength(1);
    await db.close();
  });
});

function mockUsage(role: string): { inputTokens: number; outputTokens: number } {
  const table: Record<string, { inputTokens: number; outputTokens: number }> = {
    conversation: { inputTokens: 100, outputTokens: 40 },
    critic: { inputTokens: 50, outputTokens: 12 },
    filing: { inputTokens: 80, outputTokens: 36 },
    reflection: { inputTokens: 120, outputTokens: 70 },
    debater: { inputTokens: 70, outputTokens: 48 },
    judge: { inputTokens: 90, outputTokens: 44 },
  };
  return table[role];
}
