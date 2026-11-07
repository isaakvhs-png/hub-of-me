import { describe, expect, it } from "vitest";
import { listTasks, setTaskStatus } from "../src/repo.js";
import { rememberTasks, reopenClosedByUpload } from "../src/tasks.js";
import { fresh } from "./helpers.js";

describe("repair", () => {
  it("reopens ledger items an upload closed, once, and leaves ones he closed alone", async () => {
    const { db, user } = await fresh();
    const [a, b] = await rememberTasks(db, user.id, [
      { title: "Kyoto: find a VU chair group", why: "He needs one.", owner: "system" },
      { title: "Book the train", why: "He said so.", owner: "system" },
    ], { sourceKind: "dump" });
    await setTaskStatus(db, user.id, a.id, "done", "Uploaded first day notes.txt.");
    await setTaskStatus(db, user.id, b.id, "done", "He said it was done.");
    expect(await reopenClosedByUpload(db)).toBe(1);
    const open = await listTasks(db, user.id, "open");
    expect(open.map((task) => task.id)).toEqual([a.id]);
    expect(await reopenClosedByUpload(db)).toBe(0);
  });
});
