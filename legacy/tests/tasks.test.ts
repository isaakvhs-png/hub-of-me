import { describe, expect, it } from "vitest";
import { getSoul, insertLesson, listTasks, setTaskStatus } from "../src/repo.js";
import { closeDeliveredTasks, rememberTasks } from "../src/tasks.js";
import { writeBehaviorPrinciples } from "../src/pipeline/debate.js";
import { taskMatchesDelivery, tasksToRaise } from "../src/wording.js";
import { fresh } from "./helpers.js";

describe("to-dos and behavior lessons", () => {
  it("opens tasks, closes only the one a file delivers, and archives without deleting", async () => {
    expect(taskMatchesDelivery("summary of Shinichi talk", { title: "Shinichi-talk-summary.txt", text: "We talked about the lab." })).toBe(true);
    expect(taskMatchesDelivery("summary of internship-supervisor talk", { title: "Shinichi-talk-summary.txt", text: "We talked about the lab." })).toBe(false);
    const { db, user } = await fresh();
    const shinichi = await rememberTasks(db, user.id, [{ title: "summary of Shinichi talk", why: "He said he would write it up.", owner: "system" }], { sourceKind: "dump", conversationId: "conv" });
    await rememberTasks(db, user.id, [{ title: "summary of internship-supervisor talk", why: "The other summary is still missing.", owner: "system" }], { sourceKind: "dump" });
    const closed = await closeDeliveredTasks(db, user.id, { title: "Shinichi-talk-summary.txt", text: "Notes from the Shinichi conversation." }, "Uploaded Shinichi-talk-summary.txt.");
    expect(closed.map((task) => task.id)).toEqual([shinichi[0].id]);
    const open = await listTasks(db, user.id, "open");
    expect(open.map((task) => task.title)).toEqual(["summary of internship-supervisor talk"]);
    await setTaskStatus(db, user.id, open[0].id, "archived", "No longer needed.");
    const all = await listTasks(db, user.id);
    expect(all).toHaveLength(2);
    expect(all.some((task) => task.status === "archived")).toBe(true);
    expect(await listTasks(db, user.id, "open")).toHaveLength(0);
    const raised = tasksToRaise([{ title: "summary of Shinichi talk", lastRaisedAt: new Date().toISOString() }], "unrelated", new Date());
    expect(raised).toHaveLength(0);
    const due = tasksToRaise([{ title: "summary of Shinichi talk", lastRaisedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() }], "unrelated", new Date());
    expect(due).toHaveLength(1);
    await db.close();
  });

  it("writes behavior lessons into the soul as principles and drops a quote", async () => {
    const { db, user } = await fresh();
    await insertLesson(db, user.id, { debateId: "debate-1", text: "Leave room before you push.", destination: "behavior" });
    const quote = "Living in a country he has wanted to visit for years, near a friend";
    const version = await writeBehaviorPrinciples(
      db,
      user.id,
      "debate-1",
      [quote, "Leave room before you push. Match his pace instead of filling the silence."],
      [quote],
    );
    expect(version).not.toBeNull();
    const soul = await getSoul(db, user.id);
    expect(soul?.content).toMatch(/## How to be with him/);
    expect(soul?.content).toMatch(/Leave room before you push/);
    expect(soul?.content).not.toMatch(/wanted to visit for years/);
    await db.close();
  });
});
