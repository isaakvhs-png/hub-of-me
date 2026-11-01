import type { Db } from "./db.js";
import type { Router } from "./ai/router.js";
import { completeJson } from "./ai/tracked.js";
import { id } from "./ids.js";
import { getSettings, logAction } from "./repo.js";
import { claimUpdateSchema, mindNoteSchema, reactionScoreSchema, traceSchema } from "./schemas.js";
import { iso } from "./time.js";
import { locateSpans, mindNoteProblem, type LocatedSpan } from "./trace.js";
import { z } from "zod";

export interface TraceEvent {
  id: string;
  messageId: string | null;
  start: number;
  end: number;
  phrase: string;
  destination: string;
  label: string;
  targetId: string | null;
}

const TRACE_PROMPT = `TASK: trace
Read DUMP. Point at phrases that are actually in the dump. For each, say where it is going and a short label of the work, in your own words. Do not invent phrases. destination is one of picture, world, followup, soul, debate, behavior, memory.
picture: a claim about how he thinks, values, or decides. The label is the claim, not his sentence. situations is the kind of situation that evidence covers.
world: a life thread or ongoing.
followup: something to remember to ask or do.
soul: a general principle, not a quote.
debate: something worth arguing.
behavior: how to be with him.
memory: a fact to keep.
One phrase may be going to more than one place. Return JSON: {"spans":[{"phrase":"","destination":"world","label":"","situations":""}]}

DUMP:
`;

export async function extractTrace(
  db: Db,
  ai: Router,
  userId: string,
  text: string,
  messageId: string | null,
  options?: { targetId?: string | null },
): Promise<TraceEvent[]> {
  let spans: { phrase: string; destination: string; label: string; situations?: string }[] = [];
  try {
    const parsed = await completeJson(
      db,
      userId,
      ai,
      {
        role: "filing",
        system: `${TRACE_PROMPT}${text}\nEND DUMP`,
        messages: [{ role: "user", content: "Mark the phrases." }],
      },
      traceSchema,
      { jobKind: "trace" },
    );
    spans = parsed.spans;
  } catch {
    spans = [];
  }
  const located = locateSpans(text, spans);
  const events: TraceEvent[] = [];
  for (const span of located) {
    const targetId = (await applySpan(db, userId, messageId, span)) ?? options?.targetId ?? null;
    const eventId = id();
    await db.query(
      `INSERT INTO trace_events (id, user_id, message_id, start_offset, end_offset, phrase, destination, label, target_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [eventId, userId, messageId, span.start, span.end, span.phrase, span.destination, span.label, targetId],
    );
    events.push({
      id: eventId,
      messageId,
      start: span.start,
      end: span.end,
      phrase: span.phrase,
      destination: span.destination,
      label: span.label,
      targetId,
    });
  }
  return events;
}

async function applySpan(db: Db, userId: string, messageId: string | null, span: LocatedSpan): Promise<string | null> {
  if (span.destination === "picture") {
    const claimId = id();
    await db.query(`INSERT INTO claims (id, user_id, statement, situations, status) VALUES ($1,$2,$3,$4,'tentative')`, [
      claimId,
      userId,
      span.label,
      span.situations,
    ]);
    await db.query(`INSERT INTO claim_evidence (id, claim_id, quote, source, source_id) VALUES ($1,$2,$3,'dump',$4)`, [
      id(),
      claimId,
      span.phrase,
      messageId,
    ]);
    await logAction(db, userId, {
      what: "recorded a claim",
      why: span.label,
      source: "filing",
      payload: { claimId, situations: span.situations },
    });
    return claimId;
  }
  if (span.destination === "followup") {
    const taskId = id();
    await db.query(
      `INSERT INTO tasks (id, user_id, title, why, owner, status, source_kind, source_id, why_now, surfaced) VALUES ($1,$2,$3,$4,'peter','open','dump',$5,$6,true)`,
      [taskId, userId, span.label, "From what he just said.", messageId, span.label],
    );
    return taskId;
  }
  return null;
}

export async function rememberWork(
  db: Db,
  userId: string,
  messageId: string,
  input: { label: string; destination: string; targetId: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO trace_events (id, user_id, message_id, start_offset, end_offset, phrase, destination, label, target_id) VALUES ($1,$2,$3,-1,-1,$4,$5,$4,$6)`,
    [id(), userId, messageId, input.label, input.destination, input.targetId],
  );
}

export async function listTraceForMessage(db: Db, userId: string, messageId: string): Promise<TraceEvent[]> {
  const result = await db.query(`SELECT * FROM trace_events WHERE user_id = $1 AND message_id = $2 ORDER BY start_offset`, [userId, messageId]);
  return result.rows.map(mapTrace);
}

export async function listTraceForConversation(db: Db, userId: string, conversationId: string): Promise<TraceEvent[]> {
  const result = await db.query(
    `SELECT t.* FROM trace_events t JOIN messages m ON m.id = t.message_id WHERE t.user_id = $1 AND m.conversation_id = $2 ORDER BY t.created_at`,
    [userId, conversationId],
  );
  return result.rows.map(mapTrace);
}

export async function listLooseTraces(db: Db, userId: string): Promise<TraceEvent[]> {
  const result = await db.query(`SELECT * FROM trace_events WHERE user_id = $1 AND message_id IS NULL ORDER BY created_at`, [userId]);
  return result.rows.map(mapTrace);
}

function mapTrace(row: Record<string, unknown>): TraceEvent {
  return {
    id: String(row.id),
    messageId: row.message_id == null ? null : String(row.message_id),
    start: Number(row.start_offset),
    end: Number(row.end_offset),
    phrase: String(row.phrase),
    destination: String(row.destination),
    label: String(row.label),
    targetId: row.target_id == null ? null : String(row.target_id),
  };
}

export async function recordReaction(db: Db, userId: string, input: { subjectKind: string; subjectId: string; prediction: string }): Promise<void> {
  const prediction = input.prediction.trim();
  if (!prediction) return;
  await db.query(`INSERT INTO reaction_predictions (id, user_id, subject_kind, subject_id, prediction) VALUES ($1,$2,$3,$4,$5)`, [
    id(),
    userId,
    input.subjectKind,
    input.subjectId,
    prediction,
  ]);
  await logAction(db, userId, {
    what: "predicted a reaction",
    why: prediction,
    source: "reflection",
    payload: { subjectKind: input.subjectKind, subjectId: input.subjectId },
  });
}

export async function scoreReaction(db: Db, userId: string, subjectId: string, outcome: string, score: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE reaction_predictions SET outcome = $3, score = $4, scored_at = now() WHERE id = (
      SELECT id FROM reaction_predictions WHERE user_id = $1 AND subject_id = $2 AND score IS NULL ORDER BY created_at DESC LIMIT 1
    ) RETURNING id`,
    [userId, subjectId, outcome, score],
  );
  const scored = Boolean(result.rows[0]);
  await logAction(db, userId, {
    what: scored ? "scored a prediction" : "prediction score missed",
    why: scored ? `${score}: ${outcome}` : "He responded, and no open prediction was stored for that subject.",
    source: "reflection",
    payload: { subjectId, score, scored },
  });
  return scored;
}

export type ClaimDraft = z.infer<typeof claimUpdateSchema>;

export async function saveClaims(db: Db, userId: string, drafts: ClaimDraft[], mode: "record" | "revise"): Promise<number> {
  let count = 0;
  for (const draft of drafts) {
    const statement = draft.statement.trim();
    if (!statement) continue;
    let claimId = draft.claimId ?? null;
    if (claimId) {
      const existing = await db.query(`SELECT id FROM claims WHERE id = $1 AND user_id = $2`, [claimId, userId]);
      if (!existing.rows[0]) claimId = null;
    }
    if (!claimId && mode === "record") {
      const dup = await db.query(`SELECT id FROM claims WHERE user_id = $1 AND statement = $2 LIMIT 1`, [userId, statement]);
      if (dup.rows[0]) continue;
    }
    const status = draft.status ?? (mode === "revise" ? "revised" : "tentative");
    const situations = draft.situations?.trim() ?? "";
    if (claimId) {
      await db.query(`UPDATE claims SET statement = $2, situations = $3, status = $4, updated_at = now() WHERE id = $1 AND user_id = $5`, [
        claimId,
        statement,
        situations,
        status,
        userId,
      ]);
    } else {
      claimId = id();
      await db.query(`INSERT INTO claims (id, user_id, statement, situations, status) VALUES ($1,$2,$3,$4,$5)`, [
        claimId,
        userId,
        statement,
        situations,
        status,
      ]);
    }
    for (const item of draft.evidence ?? []) {
      const quote = item.quote.trim();
      if (!quote) continue;
      await db.query(`INSERT INTO claim_evidence (id, claim_id, quote, source) VALUES ($1,$2,$3,$4)`, [id(), claimId, quote, item.source]);
    }
    await logAction(db, userId, {
      what: mode === "revise" ? "revised a claim" : "recorded a claim",
      why: statement,
      source: "reflection",
      payload: { claimId, status },
    });
    count += 1;
  }
  return count;
}

export async function listClaims(db: Db, userId: string): Promise<{ id: string; statement: string; situations: string; status: string; evidence: { quote: string; source: string }[]; updatedAt: string }[]> {
  const claims = await db.query(`SELECT * FROM claims WHERE user_id = $1 ORDER BY updated_at DESC`, [userId]);
  const evidence = await db.query(
    `SELECT e.* FROM claim_evidence e JOIN claims c ON c.id = e.claim_id WHERE c.user_id = $1 ORDER BY e.created_at`,
    [userId],
  );
  return claims.rows.map((row) => ({
    id: String(row.id),
    statement: String(row.statement),
    situations: String(row.situations ?? ""),
    status: String(row.status),
    updatedAt: iso(row.updated_at ?? row.created_at),
    evidence: evidence.rows
      .filter((item) => String(item.claim_id) === String(row.id))
      .map((item) => ({ quote: String(item.quote), source: String(item.source) })),
  }));
}

export async function listReactions(db: Db, userId: string): Promise<{ id: string; prediction: string; outcome: string | null; score: string | null; subjectKind: string; subjectId: string }[]> {
  const result = await db.query(`SELECT * FROM reaction_predictions WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return result.rows.map((row) => ({
    id: String(row.id),
    prediction: String(row.prediction),
    outcome: row.outcome == null ? null : String(row.outcome),
    score: row.score == null ? null : String(row.score),
    subjectKind: String(row.subject_kind),
    subjectId: String(row.subject_id),
  }));
}

export async function latestMindNote(db: Db, userId: string): Promise<{ id: string; content: string; createdAt: string } | null> {
  const result = await db.query(`SELECT * FROM mind_notes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId]);
  const row = result.rows[0];
  if (!row) return null;
  return { id: String(row.id), content: String(row.content), createdAt: iso(row.created_at) };
}

export async function refreshMindNote(db: Db, ai: Router, userId: string, context: string): Promise<string> {
  let last = "The note did not cover him, his world, and itself.";
  let accepted: string | null = null;
  let draft = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const drafted = await completeJson(
      db,
      userId,
      ai,
      {
        role: "filing",
        system: `TASK: mind
Write a short catch-up in your own words: him, his world and what is ongoing, and yourself (what you are curious about or working on). If one of those is quiet, name it in quiet and say why in quietWhy. Do not copy his sentences.
Return JSON {"note":"","coversPeter":true,"coversWorld":true,"coversItself":true,"quiet":[],"quietWhy":""}.

${context}`,
        messages: [{ role: "user", content: attempt === 0 ? "Write the note." : `Try again. ${last}` }],
      },
      mindNoteSchema,
      { jobKind: "mind" },
    );
    draft = drafted.note;
    const problem = mindNoteProblem(drafted);
    if (!problem) {
      accepted = drafted.note;
      break;
    }
    last = problem;
  }
  if (!accepted) {
    await logAction(db, userId, { what: "mind note withheld", why: last, source: "filing", payload: { draft } });
    return (await latestMindNote(db, userId))?.content ?? "";
  }
  await db.query(`INSERT INTO mind_notes (id, user_id, content) VALUES ($1,$2,$3)`, [id(), userId, accepted]);
  return accepted;
}

export async function scoreAnsweredAsk(db: Db, ai: Router, userId: string, askId: string, answer: string): Promise<string | null> {
  const prior = await db.query(
    `SELECT prediction FROM reaction_predictions WHERE user_id = $1 AND subject_id = $2 AND score IS NULL ORDER BY created_at DESC LIMIT 1`,
    [userId, askId],
  );
  if (!prior.rows[0]) {
    await logAction(db, userId, {
      what: "prediction score missed",
      why: "He answered an ask, and no open prediction was stored for it.",
      source: "reflection",
      payload: { askId },
    });
    return null;
  }
  const claims = await listClaims(db, userId);
  const drafted = await completeJson(
    db,
    userId,
    ai,
    {
      role: "reflection",
      system: `TASK: score
He responded to an ask. Score the prediction as hit, miss, or partial. Revise the claims the response changes. A claim is about how he thinks. His words stay in evidence quotes.
Return JSON {"score":"partial","claimUpdates":[{"statement":"","situations":"","status":"revised","evidence":[{"quote":"","source":"feedback"}]}]}

PREDICTION:
${String(prior.rows[0].prediction)}
END PREDICTION

HIS RESPONSE:
${answer}
END RESPONSE

CLAIMS:
${claims.map((claim) => `${claim.id} [${claim.status}] ${claim.statement}`).join("\n") || "(none)"}
END CLAIMS`,
      messages: [{ role: "user", content: "Score it and revise the picture." }],
    },
    reactionScoreSchema,
    { jobKind: "score" },
  );
  await scoreReaction(db, userId, askId, answer, drafted.score);
  if (drafted.claimUpdates?.length) await saveClaims(db, userId, drafted.claimUpdates, "revise");
  else {
    await logAction(db, userId, {
      what: "prediction scored",
      why: `Scored ${drafted.score}. No claim revision was returned.`,
      source: "reflection",
      payload: { askId },
    });
  }
  return drafted.score;
}

export async function markSeen(db: Db, userId: string, surface: string): Promise<void> {
  await db.query(
    `INSERT INTO visits (user_id, surface, seen_at) VALUES ($1,$2,now()) ON CONFLICT (user_id, surface) DO UPDATE SET seen_at = now()`,
    [userId, surface],
  );
}

export async function seenAt(db: Db, userId: string, surface: string): Promise<string | null> {
  const result = await db.query(`SELECT seen_at FROM visits WHERE user_id = $1 AND surface = $2`, [userId, surface]);
  const row = result.rows[0];
  return row ? iso(row.seen_at) : null;
}
