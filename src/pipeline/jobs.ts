import type { Db } from "../db.js";
import { containsContactDetail, guardSearchQuery } from "../privacy.js";
import type { Router } from "../ai/router.js";
import { completeJson, completeText } from "../ai/tracked.js";
import { briefPrompt, dutiesPrompt, researchPrompt } from "../prompts.js";
import {
  archiveEvent,
  finishJob,
  getNote,
  getSettings,
  getSoul,
  insertBrief,
  insertDiscovery,
  insertEvent,
  insertOutreach,
  insertSource,
  listActions,
  listInfoRequests,
  listOpenCarried,
  listNotes,
  logAction,
  openQueue,
  startJob,
} from "../repo.js";
import { dutiesSchema, researchSchema } from "../schemas.js";
import { archiveNote } from "./dump.js";
import { loadVisibleNotes, renderNotes } from "./context.js";

export async function expireForNow(db: Db, userId: string, now = new Date()): Promise<number> {
  const notes = await listNotes(db, userId);
  const due = notes.filter((note) => note.status === "for_now" && note.forNowExpiresAt && new Date(note.forNowExpiresAt).getTime() <= now.getTime());
  for (const note of due) {
    await archiveNote(db, userId, note.id, "The for-now bin expired.", "cleanup");
  }
  if (due.length > 0) {
    await logAction(db, userId, {
      what: `archived ${due.length} for-now note${due.length === 1 ? "" : "s"}`,
      why: "The short-lived bin expired. Rows stay; nothing is deleted.",
      source: "cleanup",
      payload: { noteIds: due.map((note) => note.id) },
    });
  }
  return due.length;
}

export async function runNightly(db: Db, ai: Router, userId: string, now = new Date()): Promise<{ archived: number; events: number; drafts: number }> {
  const jobId = await startJob(db, userId, "nightly", "Overnight cleanup and duties. Archive, never delete.");
  const meta = { jobId, jobKind: "nightly" };
  try {
    const archivedForNow = await expireForNow(db, userId, now);
    const settings = await getSettings(db, userId);
    const soul = await getSoul(db, userId);
    const visible = await loadVisibleNotes(db, userId, settings);
    const duties = await completeJson(
      db,
      userId,
      ai,
      {
        role: "duties",
        system: dutiesPrompt({ soul: soul?.content ?? "", notes: renderNotes(visible.notes), now: now.toISOString() }),
        messages: [{ role: "user", content: "Look at what is open." }],
      },
      dutiesSchema,
      meta,
    );
    let events = 0;
    let drafts = 0;
    for (const event of duties.events) {
      const starts = new Date(event.startsAt);
      const ends = new Date(event.endsAt);
      if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= starts) continue;
      await insertEvent(db, userId, { title: event.title, startsAt: starts.toISOString(), endsAt: ends.toISOString(), why: event.why, source: "duties" });
      events += 1;
    }
    for (const draft of duties.drafts) {
      await insertOutreach(db, userId, { kind: "email", draft: `${draft.subject}\n\n${draft.body}`, recipient: draft.to });
      drafts += 1;
    }
    let archived = archivedForNow;
    for (const item of duties.archives) {
      const note = await getNote(db, userId, item.noteId);
      if (!note || note.status === "archived") continue;
      await archiveNote(db, userId, note.id, item.why, "duties");
      archived += 1;
    }
    await finishJob(db, jobId, "done", `Archived ${archived}. Calendar writes ${events}. Drafts stored ${drafts}. Nothing sent, nothing deleted.`);
    return { archived, events, drafts };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nightly job failed.";
    await finishJob(db, jobId, "failed", message);
    throw error;
  }
}

export async function runResearch(db: Db, ai: Router, userId: string, topic: string): Promise<{ blocked: boolean; reason?: string; cardId?: string }> {
  const jobId = await startJob(db, userId, "research", "Research the topic and store every source.");
  const meta = { jobId, jobKind: "research" };
  try {
    const settings = await getSettings(db, userId);
    const soul = await getSoul(db, userId);
    const visible = await loadVisibleNotes(db, userId, settings);
    const form = await completeJson(
      db,
      userId,
      ai,
      {
        role: "research",
        system: researchPrompt(soul?.content ?? "", topic),
        messages: [{ role: "user", content: `TOPIC:\n${topic}\nEND TOPIC` }],
      },
      researchSchema,
      meta,
    );
    const guard = guardSearchQuery(form.query, visible.blockedBodies);
    if (!guard.ok) {
      await logAction(db, userId, { what: "search refused", why: `The query carried a ${guard.reason}.`, source: "research", payload: { topic } });
      await finishJob(db, jobId, "refused", `Search refused: ${guard.reason}.`);
      return { blocked: true, reason: guard.reason };
    }
    const sourceIds: string[] = [];
    for (const source of form.sources) {
      const blob = `${source.title} ${source.url ?? ""} ${source.excerpt ?? ""}`;
      if (containsContactDetail(blob)) {
        await logAction(db, userId, { what: "source dropped", why: "Contact details do not go into stored research.", source: "research" });
        continue;
      }
      sourceIds.push(await insertSource(db, userId, { title: source.title, url: source.url, excerpt: source.excerpt, kind: "web", origin: "research" }));
    }
    if (process.env.SEARCH_ENABLED === "true") {
      const found = await searchPublic(guard.query);
      for (const item of found) {
        if (containsContactDetail(`${item.title} ${item.url} ${item.excerpt}`)) continue;
        sourceIds.push(await insertSource(db, userId, { ...item, kind: "web", origin: "research" }));
      }
    }
    const cardId = await insertDiscovery(db, userId, { title: topic.slice(0, 140), finding: form.finding, sourceIds });
    await finishJob(db, jobId, "done", form.finding);
    return { blocked: false, cardId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Research failed.";
    await finishJob(db, jobId, "failed", message);
    throw error;
  }
}

export async function searchPublic(query: string, fetchImpl: typeof fetch = fetch): Promise<{ title: string; url: string; excerpt: string }[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const response = await fetchImpl(url);
  if (!response.ok) return [];
  const json = (await response.json()) as {
    Heading?: string;
    Abstract?: string;
    AbstractURL?: string;
    RelatedTopics?: { Text?: string; FirstURL?: string; Topics?: { Text?: string; FirstURL?: string }[] }[];
  };
  const found: { title: string; url: string; excerpt: string }[] = [];
  if (json.AbstractURL) found.push({ title: json.Heading || query, url: json.AbstractURL, excerpt: json.Abstract || "" });
  for (const topic of json.RelatedTopics ?? []) {
    if (topic.FirstURL) found.push({ title: topic.Text || topic.FirstURL, url: topic.FirstURL, excerpt: topic.Text || "" });
    for (const nested of topic.Topics ?? []) {
      if (nested.FirstURL) found.push({ title: nested.Text || nested.FirstURL, url: nested.FirstURL, excerpt: nested.Text || "" });
    }
  }
  return found.slice(0, 5);
}

export async function writeBrief(db: Db, ai: Router, userId: string): Promise<{ id: string; content: string }> {
  const soul = await getSoul(db, userId);
  const actions = await listActions(db, userId, 12);
  const waiting = await openQueue(db, userId);
  const asks = (await listInfoRequests(db, userId)).filter((item) => item.status === "open");
  const carried = await listOpenCarried(db, userId);
  const content = await completeText(db, userId, ai, {
    role: "conversation",
    system: briefPrompt({
      soul: soul?.content ?? "",
      recent: actions.map((item) => `${item.what} — ${item.why}`).join("\n"),
      waiting: [...waiting.map((item) => String(item.reason)), ...asks.map((item) => `${item.subject ? `${item.subject}: ` : ""}${item.question}`)].join("\n"),
      carried: carried.map((item) => `${item.kind}: ${item.text}`).join("\n"),
    }),
    messages: [{ role: "user", content: "Write the brief." }],
  }, { jobKind: "brief" });
  const briefId = await insertBrief(db, userId, content, "You asked for a brief.");
  return { id: briefId, content };
}

export async function archiveCalendarEvent(db: Db, userId: string, eventId: string): Promise<void> {
  await archiveEvent(db, userId, eventId, "You archived the event.");
}
