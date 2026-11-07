import { describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { claimNextDebateFeedback, finishDebateFeedback, getDebate, insertDebateFeedback, listDebateFeedback } from "../src/repo.js";
import { runReflection } from "../src/pipeline/debate.js";
import { fresh } from "./helpers.js";

describe("debate feedback", () => {
  it("appends feedback, links the next debate, and shows his words to the judge and the debaters", async () => {
    const { db, user, ai, mock } = await fresh();
    const first = await runReflection(db, ai, user.id, { cause: "Opening debate." });
    if (!("debateId" in first) || "error" in first) throw new Error("expected a debate");
    const older = await insertDebateFeedback(db, user.id, first.debateId, "Keep the first note.");
    const newer = await insertDebateFeedback(db, user.id, first.debateId, "A friend is arriving in Kyoto.");
    const stored = await listDebateFeedback(db, first.debateId);
    expect(stored.map((item) => item.body)).toEqual(["Keep the first note.", "A friend is arriving in Kyoto."]);
    expect(stored[0].id).toBe(older.id);
    expect(stored[1].createdAt >= stored[0].createdAt).toBe(true);

    const running = await claimNextDebateFeedback(db, user.id);
    expect(running?.id).toBe(older.id);
    expect(await claimNextDebateFeedback(db, user.id)).toBeNull();
    await finishDebateFeedback(db, older.id, { status: "done" });

    const follow = await runReflection(db, ai, user.id, {
      cause: "Fold in the Kyoto note.",
      trigger: { debateId: first.debateId, feedbackId: newer.id, feedback: newer.body, question: "What should the strategy do?" },
    });
    if (!("debateId" in follow) || "error" in follow) throw new Error("expected a follow-up debate");
    const next = await getDebate(db, user.id, follow.debateId);
    expect(next?.triggeredByDebateId).toBe(first.debateId);
    expect(next?.triggeredByFeedbackId).toBe(newer.id);
    const judge = mock.calls.filter((call) => call.role === "judge").at(-1);
    const debaters = mock.calls.filter((call) => call.role === "debater" && call.system.includes("Kyoto"));
    expect(judge?.system).toContain("A friend is arriving in Kyoto.");
    expect(judge?.system).toContain("HIS WORDS");
    expect(judge?.system).not.toContain("mock-debater");
    expect(debaters.length).toBeGreaterThan(0);
    await db.close();
  });

  it("queues a second comment instead of dropping it", async () => {
    const { db, user, ai } = await fresh();
    const opened = await runReflection(db, ai, user.id, { cause: "Opening debate." });
    if (!("debateId" in opened) || "error" in opened) throw new Error("expected a debate");
    const app = createApp(db);
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "peter@test", password: "secret" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const send = (text: string) =>
      app.request(`/api/debates/${opened.debateId}/feedback`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    expect((await send("First reaction.")).status).toBe(200);
    expect((await send("Second reaction, do not drop this.")).status).toBe(200);
    let page: { feedback: { body: string; status: string; ledToDebateId: string | null; soulVersion: number | null }[] } = { feedback: [] };
    for (let attempt = 0; attempt < 50; attempt += 1) {
      page = await (await app.request(`/api/debates/${opened.debateId}`, { headers: { cookie } })).json();
      if (page.feedback.length === 2 && page.feedback.every((item) => item.status === "done" || item.status === "failed")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(page.feedback.map((item) => item.body)).toEqual(["First reaction.", "Second reaction, do not drop this."]);
    expect(page.feedback.every((item) => item.ledToDebateId)).toBe(true);
    const childId = page.feedback[0].ledToDebateId as string;
    const child = await (await app.request(`/api/debates/${childId}`, { headers: { cookie } })).json();
    expect(child.triggeredBy.debateId).toBe(opened.debateId);
    expect(child.triggeredBy.question).toBeTruthy();
    expect(child.triggeredBy.feedback).toBe("First reaction.");
    await db.close();
  });
});
