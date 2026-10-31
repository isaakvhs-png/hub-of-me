import { describe, expect, it } from "vitest";
import { changeSoul, undoSoul } from "../src/soul.js";
import { undoNote } from "../src/pipeline/dump.js";
import { expireForNow } from "../src/pipeline/jobs.js";
import { countNotes, getNote, getSoul, insertNote, listEvents, listNoteVersions } from "../src/repo.js";
import { runNightly } from "../src/pipeline/jobs.js";
import { fresh } from "./helpers.js";

describe("versioning and cleanup", () => {
  it("undoes a note and the soul without dropping history", async () => {
    const { db, user } = await fresh();
    const note = await insertNote(db, user.id, {
      folderId: null,
      type: "idea",
      title: "First",
      body: "Original.",
      status: "unexplored",
      forNowExpiresAt: null,
      reason: "Created.",
      causingMessageId: null,
      source: "user",
    });
    const { reviseNote } = await import("../src/repo.js");
    await reviseNote(db, user.id, note.id, {
      folderId: null,
      type: "idea",
      title: "Second",
      body: "Edited.",
      status: "revised",
      forNowExpiresAt: null,
      reason: "You edited it.",
      causingMessageId: null,
      source: "user",
    });
    const restored = await undoNote(db, user.id, note.id);
    expect(restored.body).toBe("Original.");
    expect(restored.currentVersion).toBe(3);
    expect(await listNoteVersions(db, note.id)).toHaveLength(3);
    await changeSoul(db, user.id, { content: "Rewritten by reflection.\n", reason: "A commitment.", via: "reflection" });
    const undone = await undoSoul(db, user.id);
    expect(undone.version).toBe(3);
    expect(undone.content).toMatch(/How this system thinks/);
    expect((await getSoul(db, user.id))?.version).toBe(3);
    await expect(changeSoul(db, user.id, { content: "no", reason: "chat", via: "conversation" })).rejects.toThrow(/reflection/);
    await db.close();
  });

  it("expires the for-now bin by archiving", async () => {
    const { db, user, ai } = await fresh();
    const note = await insertNote(db, user.id, {
      folderId: null,
      type: "todo",
      title: "Only for now",
      body: "Throwaway plan.",
      status: "for_now",
      forNowExpiresAt: "2020-01-01T00:00:00.000Z",
      reason: "Short-lived.",
      causingMessageId: null,
      source: "filing",
    });
    const archived = await expireForNow(db, user.id, new Date("2026-10-31T00:00:00.000Z"));
    expect(archived).toBe(1);
    expect((await getNote(db, user.id, note.id))?.status).toBe("archived");
    expect(await countNotes(db, user.id)).toBe(1);
    await runNightly(db, ai, user.id, new Date("2026-10-31T03:00:00.000Z"));
    const events = await listEvents(db, user.id, "2026-10-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z");
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].source).toBe("duties");
    expect(events[0].why).toBeTruthy();
    expect(await countNotes(db, user.id)).toBe(1);
    await db.close();
  });
});
