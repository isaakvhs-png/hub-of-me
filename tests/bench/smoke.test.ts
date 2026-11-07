import { describe, expect, it } from "vitest";
import { bench } from "./helpers.js";

describe("bench smoke: a message runs the whole engine", () => {
  it("answers a plain message and records every step", async () => {
    const b = await bench();
    const runId = await b.say("Hello. I'm Isaak, I work at Wetlands International on mangrove restoration.");
    const steps = await b.steps(runId);
    const nodes = steps.map((s) => s.node);
    expect(nodes).toEqual(expect.arrayContaining(["you/send", "queue/tyou", "run/starter", "run/gather/gplan", "run/fetch", "run/pack", "run/callA", "run/reply", "run/callB", "run/record"]));
    const replies = await b.rows<{ content: string }>(`SELECT content FROM stream WHERE kind='its'`);
    expect(replies.length).toBe(1);
    const run = (await b.rows<{ status: string; error: string }>(`SELECT status, error FROM runs WHERE id=$1`, [runId]))[0];
    expect(run.error).toBe("");
    expect(run.status).toBe("done");
    await b.close();
  });
});
