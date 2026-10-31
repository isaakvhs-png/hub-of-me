import { describe, expect, it } from "vitest";
import { getSoul, insertPrediction, listPredictions, listInfoRequests, updateInfoRequest } from "../src/repo.js";
import { applyOutcome, runReflection } from "../src/pipeline/debate.js";
import { reflectionRejection } from "../src/hedge.js";
import { partitionEvidence, shuffle } from "../src/pipeline/context.js";
import { runDump } from "../src/pipeline/dump.js";
import { fresh } from "./helpers.js";

describe("debate conditions", () => {
  it("sends a hedged verdict back and does not touch the soul", async () => {
    const { db, user, ai, mock } = await fresh();
    mock.hedgeOnRole.judge = 5;
    const result = await runDump(db, ai, user.id, { text: "A hedged debate should not land." });
    expect(result.reflection && "error" in result.reflection).toBe(true);
    expect((await getSoul(db, user.id))?.version).toBe(1);
    const judgeCalls = mock.calls.filter((call) => call.role === "judge");
    expect(judgeCalls.length).toBe(3);
    await db.close();
  });

  it("requires an uncomfortable side and a real commitment", async () => {
    expect(reflectionRejection("It depends.")).toMatch(/hedged/);
    expect(reflectionRejection("A list of options.")).toMatch(/commitment/);
    expect(reflectionRejection("This matters most now, because the record is thin, at the cost of waiting.")).toBeNull();
    const { db, user, ai, mock } = await fresh();
    mock.planMissingUncomfortable = 1;
    const result = await runDump(db, ai, user.id, { text: "Try the plan once without the hard side." });
    expect(result.reflection && "commitment" in result.reflection).toBe(true);
    const plans = mock.calls.filter((call) => call.role === "reflection" && call.system.includes("TASK: plan"));
    expect(plans.length).toBe(2);
    await db.close();
  });

  it("anonymises and shuffles before the judge", () => {
    const reversed = shuffle(["keep", "aside"], () => 0);
    expect(reversed).toEqual(["aside", "keep"]);
    const slices = partitionEvidence(["n1", "n2", "n3"], 2, [[], []]);
    expect(slices[0]).not.toEqual(slices[1]);
    expect(slices.flat().sort()).toEqual(["n1", "n2", "n3"]);
  });

  it("checks a prediction against an outcome and skips a question he never wants", async () => {
    const { db, user, ai } = await fresh();
    const predictionId = await insertPrediction(db, user.id, null, "He will return to the same thread.");
    await applyOutcome(
      db,
      user.id,
      "debate",
      {
        commitment: "This matters most now, because the bet can be checked, at the cost of leaving it open.",
        predictionChecks: [{ id: predictionId, cameTrue: false, observed: "He moved on." }],
        infoRequests: [{ question: "What would you put down to stay with this?", why: "Need a cost." }],
      },
      null,
    );
    const [prediction] = await listPredictions(db, user.id);
    expect(prediction.cameTrue).toBe(false);
    expect(prediction.outcome).toBe("He moved on.");
    const [ask] = await listInfoRequests(db, user.id);
    await updateInfoRequest(db, user.id, String(ask.id), { status: "never" });
    await runReflection(db, ai, user.id, { cause: "Second pass should not repeat a refused question." });
    const asks = await listInfoRequests(db, user.id);
    expect(asks.filter((item) => item.status === "open")).toHaveLength(0);
    await db.close();
  });
});
