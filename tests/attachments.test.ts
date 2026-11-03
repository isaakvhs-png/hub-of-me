import { describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { appendAttachments, filesFromField, removeAttachment } from "../src/attachments.js";
import { createDb, migrate } from "../src/db.js";
import { listNotes, listTasks } from "../src/repo.js";
import { ensureUser } from "../src/seed.js";
import { rememberTasks } from "../src/tasks.js";

describe("dump attachments", () => {
  it("keeps every chosen file and drops only the one that was removed", () => {
    const first = { name: "orchard-notes.txt" };
    const second = { name: "harbor-notes.txt" };
    const waiting = appendAttachments([first], [second]);
    expect(waiting.map((item) => item.name)).toEqual(["orchard-notes.txt", "harbor-notes.txt"]);
    expect(appendAttachments(waiting, []).map((item) => item.name)).toEqual(["orchard-notes.txt", "harbor-notes.txt"]);
    expect(removeAttachment(waiting, 0).map((item) => item.name)).toEqual(["harbor-notes.txt"]);
    const uploads = filesFromField([
      { name: "orchard-notes.txt", arrayBuffer: async () => new ArrayBuffer(0) },
      { name: "", arrayBuffer: async () => new ArrayBuffer(0) },
      "not a file",
    ]);
    expect(uploads.map((file) => file.name)).toEqual(["orchard-notes.txt", "upload"]);
  });

  it("files each upload whole and leaves the ledger for it to decide", async () => {
    const db = await createDb({ memory: true });
    await migrate(db);
    const user = await ensureUser(db, { email: "peter@test", password: "secret", name: "Peter", provider: "mock" });
    await rememberTasks(db, user.id, [{ title: "summary of orchard", why: "He said he would write it up.", owner: "system" }], { sourceKind: "dump" });
    await rememberTasks(db, user.id, [{ title: "summary of harbor", why: "The other summary is still missing.", owner: "system" }], { sourceKind: "dump" });
    await rememberTasks(db, user.id, [{ title: "summary of meadow", why: "This one was not attached.", owner: "system" }], { sourceKind: "dump" });
    const app = createApp(db);
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "peter@test", password: "secret" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const form = new FormData();
    form.append("file", new File(["We walked the orchard rows."], "orchard-notes.txt", { type: "text/plain" }));
    form.append("file", new File(["The harbor was calm."], "harbor-notes.txt", { type: "text/plain" }));
    const response = await app.request("/api/dump/file", { method: "POST", headers: { cookie }, body: form });
    expect(response.status).toBe(200);
    const body = await response.json() as { notes: { title: string }[]; closed: { title: string }[]; conversationId: string };
    expect(body.notes.map((note) => note.title)).toEqual(["orchard-notes.txt", "harbor-notes.txt"]);
    expect(body.closed).toEqual([]);
    expect(await listTasks(db, user.id, "open")).toHaveLength(3);
    expect(await listTasks(db, user.id, "done")).toHaveLength(0);
    expect(await listNotes(db, user.id)).toHaveLength(2);
    const messages = await app.request(`/api/conversations/${body.conversationId}/messages`, { headers: { cookie } });
    const rows = await messages.json() as { role: string; content: string }[];
    expect(rows.filter((row) => row.role === "user").map((row) => row.content)).toEqual([
      expect.stringContaining("orchard-notes.txt"),
      expect.stringContaining("harbor-notes.txt"),
    ]);
    await db.close();
  });
});
