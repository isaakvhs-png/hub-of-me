import type { Db } from "../db.js";
import { containsContactDetail } from "../privacy.js";
import type { Router } from "../ai/router.js";
import { completeJson, completeText } from "../ai/tracked.js";
import { conversationPrompt, criticPrompt, filingPrompt } from "../prompts.js";
import {
  addMessage,
  createConversation,
  enqueueReflection,
  ensureFolderPath,
  getConversation,
  getSettings,
  getSoul,
  insertConflict,
  insertNote,
  insertSource,
  listNoteVersions,
  logAction,
  reviseNote,
} from "../repo.js";
import { criticSchema, filingSchema } from "../schemas.js";
import type { Note } from "../types.js";
import { loadVisibleNotes, renderNotes } from "./context.js";
import { runReflection } from "./debate.js";

export interface DumpResult {
  conversationId: string;
  reply: string;
  userMessageId: string;
  notes: Note[];
  filingError: string | null;
  reflection: { debateId: string; soulVersion: number; commitment: string } | { error: string } | null;
}

export async function runDump(db: Db, ai: Router, userId: string, input: { text: string; conversationId?: string | null }): Promise<DumpResult> {
  const text = input.text.trim();
  if (!text) throw new Error("The dump is empty.");
  const settings = await getSettings(db, userId);
  const soul = await getSoul(db, userId);
  if (!soul) throw new Error("Soul is missing.");
  const user = await db.query(`SELECT name FROM users WHERE id = $1`, [userId]);
  const name = String(user.rows[0]?.name ?? "Peter");
  let conversationId = input.conversationId ?? null;
  if (!conversationId || !(await getConversation(db, userId, conversationId))) {
    conversationId = await createConversation(db, userId, text.split("\n")[0] || "Dump");
  }
  const userMessageId = await addMessage(db, conversationId, "user", text);
  const visible = await loadVisibleNotes(db, userId, settings);
  const meta = { conversationId, jobKind: "conversation" as const };
  const noteBlock = renderNotes(visible.notes);
  let reply = await completeText(
    db,
    userId,
    ai,
    {
      role: "conversation",
      system: conversationPrompt({ soul: soul.content, notes: noteBlock, name }),
      messages: [{ role: "user", content: `DUMP:\n${text}\nEND DUMP` }],
    },
    meta,
  );
  const critic = await completeJson(
    db,
    userId,
    ai,
    {
      role: "critic",
      system: criticPrompt(soul.content),
      messages: [{ role: "user", content: `REPLY:\n${reply}\nEND REPLY` }],
    },
    criticSchema,
    meta,
  );
  if (!critic.ok) {
    reply = await completeText(
      db,
      userId,
      ai,
      {
        role: "conversation",
        system: conversationPrompt({ soul: soul.content, notes: noteBlock, name }),
        messages: [
          { role: "user", content: `DUMP:\n${text}\nEND DUMP` },
          { role: "assistant", content: reply },
          { role: "user", content: `The critic sent this back: ${critic.problem || "Take a stance."}` },
        ],
      },
      meta,
    );
  }
  await addMessage(db, conversationId, "assistant", reply);

  let notes: Note[] = [];
  let filingError: string | null = null;
  let flagged = false;
  try {
    const form = await completeJson(
      db,
      userId,
      ai,
      {
        role: "filing",
        system: filingPrompt({ soul: soul.content, notes: noteBlock }),
        messages: [{ role: "user", content: `DUMP:\n${text}\nEND DUMP` }],
      },
      filingSchema,
      meta,
    );
    for (const item of form.notes) {
      const folderId = await ensureFolderPath(db, userId, item.folder);
      const hours = item.status === "for_now" ? (item.forNowHours ?? settings.forNowTtlHours) : null;
      const saved = await insertNote(db, userId, {
        folderId,
        type: item.type,
        title: item.title,
        body: item.body,
        status: item.status,
        forNowExpiresAt: hours ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : null,
        reason: "Filed from a dump.",
        causingMessageId: userMessageId,
        source: "filing",
        mockEra: settings.provider === "mock",
      });
      notes.push(saved);
      if (item.contradicts) {
        await insertConflict(db, userId, item.contradictionWith || `The new note "${item.title}" conflicts with an earlier one.`, [saved.id]);
      }
      if (item.flagForReflection || item.flagForSoul) {
        flagged = true;
        await enqueueReflection(db, userId, saved.id, item.flagForSoul ? "Flagged for the soul." : "Flagged for reflection.");
      }
    }
    for (const source of form.sources ?? []) {
      const blob = `${source.title} ${source.url ?? ""} ${source.excerpt ?? ""}`;
      if (containsContactDetail(blob)) {
        await logAction(db, userId, { what: "source dropped", why: "It carried a contact detail.", source: "filing", payload: { title: source.title } });
        continue;
      }
      await insertSource(db, userId, { title: source.title, url: source.url, excerpt: source.excerpt, kind: "bookmark", origin: "filing" });
    }
  } catch (error) {
    filingError = error instanceof Error ? error.message : "Filing failed.";
    await logAction(db, userId, { what: "filing failed", why: filingError, source: "filing", payload: { conversationId } });
  }

  let reflection: DumpResult["reflection"] = null;
  if (flagged) {
    reflection = await runReflection(db, ai, userId, {
      cause: "A filed note was flagged, so reflection ran. The soul only changes through reflection.",
      conversationId,
      causingMessageId: userMessageId,
    });
  }
  return { conversationId, reply, userMessageId, notes, filingError, reflection };
}

export async function undoNote(db: Db, userId: string, noteId: string): Promise<Note> {
  const { getNote } = await import("../repo.js");
  const note = await getNote(db, userId, noteId);
  if (!note) throw new Error("Note not found.");
  const versions = await listNoteVersions(db, noteId);
  const previous = versions[1];
  if (!previous) throw new Error("There is no earlier version to restore.");
  return reviseNote(db, userId, noteId, {
    folderId: previous.folderId,
    type: previous.type,
    title: previous.title,
    body: previous.body,
    status: previous.status,
    forNowExpiresAt: note.forNowExpiresAt,
    reason: `Undo to version ${previous.version}.`,
    causingMessageId: null,
    source: "user",
  });
}

export async function archiveNote(db: Db, userId: string, noteId: string, why: string, source: string): Promise<Note> {
  const { getNote } = await import("../repo.js");
  const note = await getNote(db, userId, noteId);
  if (!note) throw new Error("Note not found.");
  return reviseNote(db, userId, noteId, {
    folderId: note.folderId,
    type: note.type,
    title: note.title,
    body: note.body,
    status: "archived",
    forNowExpiresAt: note.forNowExpiresAt,
    reason: why,
    causingMessageId: null,
    source,
  });
}
