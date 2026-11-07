import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertCanReachOut, assertNotDelete, assertNotSigningIn } from "../src/boundaries.js";
import { archiveNote } from "../src/pipeline/dump.js";
import { countNotes, getNote, insertNote, listOutreach } from "../src/repo.js";
import { runNightly } from "../src/pipeline/jobs.js";
import { guardSearchQuery } from "../src/privacy.js";
import { assertGmailReadOnly, assertGmailScopes, GMAIL_SCOPES, gmailAuthUrl, gmailModule } from "../src/modules/gmail.js";
import { fresh } from "./helpers.js";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|js|mjs|cjs|sql)$/.test(entry)) out.push(path);
  }
  return out;
}

describe("hard boundaries", () => {
  it("archives and never deletes", async () => {
    const { db, user } = await fresh();
    const note = await insertNote(db, user.id, {
      folderId: null,
      type: "idea",
      title: "Keep me",
      body: "Still here.",
      status: "unexplored",
      forNowExpiresAt: null,
      reason: "Test note.",
      causingMessageId: null,
      source: "user",
    });
    await archiveNote(db, user.id, note.id, "Outdated.", "user");
    expect(await countNotes(db, user.id)).toBe(1);
    expect((await getNote(db, user.id, note.id))?.status).toBe("archived");
    expect(() => assertNotDelete("delete_note")).toThrow(/Archive/);
    const corpus = ["src", "server"].filter((dir) => existsSync(dir)).flatMap((dir) => sourceFiles(dir)).map((path) => readFileSync(path, "utf8")).join("\n");
    expect(corpus).not.toContain("DELETE FROM");
    await db.close();
  });

  it("does not send mail or sign in, and keeps gmail read-only", () => {
    expect(() => assertCanReachOut({ channel: "email", explicitYes: false })).toThrow(/read and draft only/);
    expect(() => assertCanReachOut({ channel: "email", explicitYes: true })).toThrow(/read and draft only/);
    expect(() => assertCanReachOut({ channel: "send_message", explicitYes: false })).toThrow(/explicit yes/);
    expect(() => assertCanReachOut({ channel: "send_message", explicitYes: true })).toThrow(/No outreach channel/);
    expect(() => assertNotSigningIn("enter_password")).toThrow(/passwords/);
    expect(() => assertNotSigningIn("sign_in")).toThrow(/sign in/);
    expect(GMAIL_SCOPES).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(() => assertGmailScopes(["https://www.googleapis.com/auth/gmail.send"])).toThrow(/readonly/);
    expect(() => assertGmailScopes(["https://www.googleapis.com/auth/drive.readonly"])).toThrow(/readonly/);
    expect(() => assertGmailReadOnly("send")).toThrow(/read-only/);
    expect("send" in gmailModule).toBe(false);
    expect("sendMail" in gmailModule).toBe(false);
    const url = new URL(gmailAuthUrl({ redirectUri: "http://127.0.0.1/callback", state: "abc", clientId: "client" }));
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.get("scope")).not.toMatch(/drive|photos|send/i);
  });

  it("refuses private material in a web search", () => {
    expect(guardSearchQuery("how attention shifts during long projects").ok).toBe(true);
    expect(guardSearchQuery("email peter@example.com about the draft").ok).toBe(false);
    expect(guardSearchQuery("call +31 6 1234 5678").ok).toBe(false);
    expect(guardSearchQuery("the password is hunter2").ok).toBe(false);
    const guarded = guardSearchQuery("what happened with the blue notebook on the train", ["the blue notebook on the train"]);
    expect(guarded.ok).toBe(false);
  });

  it("the nightly job writes no drafts and sends nothing", async () => {
    const { db, user, ai } = await fresh();
    await runNightly(db, ai, user.id, new Date("2026-10-31T12:00:00.000Z"));
    const drafts = await listOutreach(db, user.id);
    expect(drafts.every((draft) => draft.status === "draft" && draft.explicitYes === false)).toBe(true);
    await db.close();
  });
});
