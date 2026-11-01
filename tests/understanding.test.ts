import { describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { listInfoRequests, getSoul } from "../src/repo.js";
import { latestMindNote, listClaims, listReactions, refreshMindNote, scoreAnsweredAsk } from "../src/picture.js";
import { runDump } from "../src/pipeline/dump.js";
import { runReflection } from "../src/pipeline/debate.js";
import { ensureCuriosity } from "../src/soul.js";
import { locateSpans, mindNoteProblem } from "../src/trace.js";
import { fresh } from "./helpers.js";

describe("understanding", () => {
  it("locates one phrase onto several destinations and drops a phrase that is not there", () => {
    const text = "I would rather learn the work than take the title.";
    const spans = locateSpans(text, [
      { phrase: "rather learn the work", destination: "picture", label: "He weighs the work itself" },
      { phrase: "rather learn the work", destination: "world", label: "A thread about the work" },
      { phrase: "this phrase is not in the dump", destination: "memory", label: "Missing" },
    ]);
    expect(spans).toHaveLength(2);
    expect(spans[0].start).toBe(spans[1].start);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("rather learn the work");
    expect(spans.map((span) => span.destination).sort()).toEqual(["picture", "world"]);
  });

  it("rejects a mind note that skips a part without saying why", () => {
    expect(mindNoteProblem({ note: "", coversPeter: true, coversWorld: true, coversItself: true, quiet: [] })).toMatch(/empty/i);
    expect(mindNoteProblem({
      note: "Him only.",
      coversPeter: true,
      coversWorld: false,
      coversItself: false,
      quiet: [],
    })).toMatch(/world/i);
    expect(mindNoteProblem({
      note: "Him, and the world is quiet.",
      coversPeter: true,
      coversWorld: false,
      coversItself: true,
      quiet: ["world"],
    })).toMatch(/why/i);
    expect(mindNoteProblem({
      note: "Him. The world is quiet because nothing ongoing was said. I am looking.",
      coversPeter: true,
      coversWorld: false,
      coversItself: true,
      quiet: ["world"],
      quietWhy: "Nothing ongoing was said.",
    })).toBeNull();
  });

  it("adds curiosity once, through a soul edit", async () => {
    const { db, user } = await fresh();
    const soul = await getSoul(db, user.id);
    expect(soul?.content.toLowerCase()).toContain("curiosity");
    const before = soul?.version ?? 0;
    expect(await ensureCuriosity(db)).toBe(0);
    const stripped = String(soul?.content).replace(/Curiosity is a core value\..*?paper over\.\s*/i, "");
    expect(stripped.toLowerCase()).not.toContain("curiosity");
    await db.query(`UPDATE soul_versions SET content = $2 WHERE user_id = $1 AND version = $3`, [user.id, stripped, before]);
    expect(await ensureCuriosity(db)).toBe(1);
    const next = await getSoul(db, user.id);
    expect(next?.version).toBe(before + 1);
    expect(next?.reason).toBe("Curiosity is a core value of how this system understands him.");
    expect(next?.content.toLowerCase()).toContain("curiosity");
    expect(await ensureCuriosity(db)).toBe(0);
    await db.close();
  });

  it("traces a dump, keeps a mind note, and revises a claim when a prediction is scored", async () => {
    const { db, user, ai, mock } = await fresh();
    const text = "I would rather learn the work than take the title.";
    const dumped = await runDump(db, ai, user.id, { text });
    expect(dumped.traces.length).toBeGreaterThan(0);
    const span = dumped.traces[0];
    expect(text.slice(span.start, span.end)).toBe(span.phrase);
    const mind = await latestMindNote(db, user.id);
    expect(mind?.content.toLowerCase()).toContain("curious");
    if (!dumped.reflection || !("debateId" in dumped.reflection)) throw new Error("no debate");
    const claims = await listClaims(db, user.id);
    expect(claims.some((claim) => claim.status === "tentative")).toBe(true);
    const asks = await listInfoRequests(db, user.id);
    expect(asks[0]?.rank).toBe(0);
    expect(String(asks[0]?.subject).length).toBeGreaterThan(0);
    mock.mindRejects = 2;
    expect(await refreshMindNote(db, ai, user.id, "Another pass.")).toBe(mind?.content);
    const again = await runReflection(db, ai, user.id, {
      cause: "He responded.",
      trigger: {
        debateId: dumped.reflection.debateId,
        feedbackId: "feedback",
        feedback: "That only half fits.",
        question: "the strategy",
      },
    });
    expect("error" in again).toBe(false);
    const scored = await listReactions(db, user.id);
    expect(scored.some((item) => item.score === "partial")).toBe(true);
    const revised = await listClaims(db, user.id);
    expect(revised.some((claim) => claim.status === "revised")).toBe(true);
    const ask = asks.find((item) => item.status === "open");
    if (!ask) throw new Error("no ask");
    expect(await scoreAnsweredAsk(db, ai, user.id, String(ask.id), "The cost is the unexplored dump.")).toBe("partial");
    await db.close();
  });

  it("streams span events while a dump is filed", async () => {
    const { db } = await fresh();
    const app = createApp(db);
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "peter@test", password: "secret" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const response = await app.request("/api/dump/stream", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "I would rather learn the work than take the title." }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("event: span");
    expect(body).toContain("event: mind");
    expect(body).toContain("event: done");
    await db.close();
  });
});
