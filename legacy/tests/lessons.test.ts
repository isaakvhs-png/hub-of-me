import { describe, expect, it } from "vitest";
import { listLessons, listOpenCarried } from "../src/repo.js";
import { runReflection } from "../src/pipeline/debate.js";
import { askProblem, copiedPhrase, takeCarriedCitations } from "../src/wording.js";
import { fresh } from "./helpers.js";

describe("lessons, soul wording, and asks", () => {
  it("keeps exact words out of the soul and rejects an ask that says this", () => {
    const source = "Living in a country he has wanted to visit for years, near a friend";
    expect(copiedPhrase(`Living in a country he has wanted to visit for years, near a friend who writes.`, [source])).toBeTruthy();
    expect(copiedPhrase("Choose a place for the life it makes possible, not for the scene in one story.", [source])).toBeNull();
    expect(askProblem({
      subject: "this",
      question: "What would you put down to stay with this?",
      context: "The commitment needs a real cost, and the record does not name one.",
    })).toMatch(/subject/i);
    expect(askProblem({
      subject: "keeping the latest dump in view",
      question: "What would you put down to stay with keeping the latest dump in view?",
      context: "The debate committed to keeping the latest dump visible, and the record does not name what that costs.",
    })).toBeNull();
    const cited = takeCarriedCitations("Hold the strategy.\nUsed: 11111111-1111-1111-1111-111111111111");
    expect(cited.text).toBe("Hold the strategy.");
    expect(cited.ids).toEqual(["11111111-1111-1111-1111-111111111111"]);
  });

  it("stores the winner's lesson and the losing side's point as carried memory", async () => {
    const { db, user, ai } = await fresh();
    const result = await runReflection(db, ai, user.id, { cause: "A filed note was flagged." });
    if (!("debateId" in result) || "error" in result) throw new Error("expected a debate");
    const lessons = await listLessons(db, result.debateId);
    expect(lessons.some((lesson) => lesson.destination === "soul" && lesson.soulVersion != null)).toBe(true);
    expect(lessons.some((lesson) => String(lesson.text).includes("dump"))).toBe(true);
    const carried = await listOpenCarried(db, user.id);
    expect(carried.some((item) => item.kind === "memory" && item.debateId === result.debateId)).toBe(true);
    await db.close();
  });
});
