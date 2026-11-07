import type { Db } from "../db.js";
import type { Router } from "../ai/router.js";
import { debaterPool, freeDebaterIsWiser, resolveRoleModel } from "../ai/router.js";
import { completeJson } from "../ai/tracked.js";
import { commitPrompt, debaterPrompt, hisWordsBlock, judgePrompt, planPrompt } from "../prompts.js";
import {
  concludeDebate,
  failDebate,
  finishJob,
  getBudget,
  getSettings,
  getSoul,
  insertCarried,
  insertDebate,
  insertDebateSide,
  insertEvidenceQuote,
  insertInfoRequest,
  insertLesson,
  insertPicture,
  insertPrediction,
  insertPreference,
  listConflicts,
  listFeedback,
  listInfoRequests,
  listNotes,
  listPredictions,
  listRecentDumps,
  logAction,
  markQueueHandled,
  spendSince,
  openQueue,
  resolveConflict,
  setPredictionOutcome,
  startJob,
  updateDebateSide,
} from "../repo.js";
import { extractJson } from "../json.js";
import { ValidationError } from "../errors.js";
import { askProblem, copiedPhrase, looksLikeAction } from "../wording.js";
import { startOfMonth } from "../time.js";
import { listClaims, recordReaction, saveClaims, scoreReaction } from "../picture.js";
import { argumentSchema, debatePlanSchema, judgmentSchema, reflectionOutcomeSchema, type ReflectionOutcome } from "../schemas.js";
import { changeSoul, mergeSoulSections } from "../soul.js";
import { loadVisibleNotes, partitionEvidence, renderNotes, scrubArgument, shuffle } from "./context.js";

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export async function applyOutcome(db: Db, userId: string, debateId: string, outcome: ReflectionOutcome, causingMessageId?: string | null): Promise<number> {
  const notes = await listNotes(db, userId);
  const noteIds = new Set(notes.map((note) => note.id));
  const samples = await listFeedback(db, userId);
  const sampleIds = new Set(samples.map((sample) => String(sample.id)));
  const conflicts = await listConflicts(db, userId);
  const conflictIds = new Set(conflicts.map((conflict) => String(conflict.id)));
  const predictions = await listPredictions(db, userId);
  const predictionIds = new Set(predictions.map((prediction) => String(prediction.id)));
  const never = new Set((await listInfoRequests(db, userId)).filter((request) => request.status === "never").map((request) => norm(String(request.question))));
  const openQuestions = new Set((await listInfoRequests(db, userId)).filter((request) => request.status === "open").map((request) => norm(String(request.question))));

  const currentSoul = await getSoul(db, userId);
  let soulVersion = currentSoul?.version ?? 0;
  if (outcome.soul) {
    if (!currentSoul) throw new Error("Soul is missing.");
    const saved = await changeSoul(db, userId, {
      content: mergeSoulSections(currentSoul.content, outcome.soul.sections),
      reason: outcome.soul.reason,
      via: "reflection",
      causingMessageId,
    });
    soulVersion = saved.version;
  }
  for (const line of outcome.picture ?? []) {
    const evidence = line.evidenceNoteIds.filter((item) => noteIds.has(item));
    await insertPicture(db, userId, line.statement, evidence);
  }
  for (const rule of outcome.preferenceRules ?? []) {
    const evidence = rule.evidenceSampleIds.filter((item) => sampleIds.has(item));
    if (evidence.length === 0) continue;
    await insertPreference(db, userId, rule.statement, evidence);
  }
  for (const line of outcome.picture ?? []) {
    await saveClaims(
      db,
      userId,
      [
        {
          statement: line.statement,
          status: "tentative",
          evidence: (outcome.evidence ?? []).map((quote) => ({ quote: quote.quote, source: quote.source })),
        },
      ],
      "record",
    );
  }
  if (outcome.claimUpdates?.length) await saveClaims(db, userId, outcome.claimUpdates, "revise");
  else if (outcome.predictionScore) {
    await logAction(db, userId, {
      what: "prediction scored",
      why: `Scored ${outcome.predictionScore}. No claim revision was returned.`,
      source: "reflection",
      payload: { debateId },
    });
  }
  for (let index = 0; index < (outcome.infoRequests ?? []).length; index += 1) {
    const request = outcome.infoRequests?.[index];
    if (!request) continue;
    const problem = askProblem(request);
    if (problem) throw new ValidationError(problem);
    const key = norm(request.question);
    if (never.has(key) || openQuestions.has(key)) continue;
    const requestId = await insertInfoRequest(db, userId, {
      question: request.question,
      why: request.why,
      subject: request.subject,
      context: request.context,
      debateId,
      rank: index,
    });
    openQuestions.add(key);
    const prediction = request.expect?.trim() ?? "";
    if (prediction) {
      await recordReaction(db, userId, { subjectKind: "ask", subjectId: requestId, prediction });
    } else {
      await logAction(db, userId, {
        what: "prediction missing",
        why: `An ask about ${request.subject} was stored without the model's prediction, so a placeholder was recorded.`,
        source: "reflection",
        payload: { requestId },
      });
      await recordReaction(db, userId, {
        subjectKind: "ask",
        subjectId: requestId,
        prediction: `He will respond to the ask about ${request.subject}.`,
      });
    }
  }
  for (const quote of outcome.evidence ?? []) {
    await insertEvidenceQuote(db, userId, { debateId, quote: quote.quote, source: quote.source });
  }
  for (const prediction of outcome.predictions ?? []) {
    await insertPrediction(db, userId, debateId, prediction);
  }
  for (const check of outcome.predictionChecks ?? []) {
    if (!predictionIds.has(check.id)) continue;
    await setPredictionOutcome(db, userId, check.id, { cameTrue: check.cameTrue, observed: check.observed });
    await logAction(db, userId, { what: "prediction checked", why: check.observed, source: "reflection", payload: { predictionId: check.id, cameTrue: check.cameTrue } });
  }
  for (const resolved of outcome.conflictsResolved ?? []) {
    if (!conflictIds.has(resolved.conflictId)) continue;
    await resolveConflict(db, userId, resolved.conflictId, resolved.resolution);
    await logAction(db, userId, { what: "tension resolved", why: resolved.resolution, source: "reflection", payload: { conflictId: resolved.conflictId } });
  }
  return soulVersion;
}

export async function writeBehaviorPrinciples(db: Db, userId: string, debateId: string, lines: string[], verbatim: string[]): Promise<number | null> {
  const principles = lines.filter((text) => !copiedPhrase(text, verbatim));
  if (!principles.length) return null;
  const currentSoul = await getSoul(db, userId);
  if (!currentSoul) return null;
  const saved = await changeSoul(db, userId, {
    content: mergeSoulSections(currentSoul.content, [{ heading: "How to be with him", body: principles.join("\n") }]),
    reason: "How to be with him, as a general principle from the debate.",
    via: "reflection",
  });
  await db.query(`UPDATE debate_lessons SET soul_version = $2 WHERE debate_id = $1 AND destination = 'behavior'`, [debateId, saved.version]);
  return saved.version;
}

export async function runReflection(
  db: Db,
  ai: Router,
  userId: string,
  opts: {
    cause: string;
    conversationId?: string | null;
    causingMessageId?: string | null;
    rng?: () => number;
    trigger?: { debateId: string; feedbackId: string; feedback: string; question: string };
  },
): Promise<{ debateId: string; soulVersion: number; commitment: string } | { error: string; debateId: string | null }> {
  const rng = opts.rng ?? Math.random;
  const jobId = await startJob(db, userId, "debate", opts.cause);
  const meta = { conversationId: opts.conversationId ?? null, jobId, jobKind: "debate" };
  let debateId: string | null = null;
  try {
    const settings = await getSettings(db, userId);
    const soul = await getSoul(db, userId);
    if (!soul) throw new Error("Soul is missing.");
    const { notes } = await loadVisibleNotes(db, userId, settings);
    const queue = await openQueue(db, userId);
    const noteText = renderNotes(notes);
    const dumps = opts.trigger ? await listRecentDumps(db, userId, 5) : [];
    const hisWords = opts.trigger ? hisWordsBlock(opts.trigger.feedback, dumps.map((dump) => dump.content)) : "";
    const plan = await completeJson(
      db,
      userId,
      ai,
      {
        role: "reflection",
        system: planPrompt({ soul: soul.content, notes: noteText, queue: queue.map((item) => `${item.noteId}: ${item.reason}`).join("\n"), hisWords }),
        messages: [{ role: "user", content: "Choose the question and the sides." }],
      },
      debatePlanSchema,
      meta,
    );
    const budget = await getBudget(db, userId);
    const spent = await spendSince(db, userId, startOfMonth("Europe/Amsterdam").toISOString());
    const allowFreeLite = settings.provider !== "mock" && freeDebaterIsWiser(budget.monthlyCapEurCents - spent.spentEurCents, budget.monthlyCapEurCents);
    if (settings.provider !== "mock") debaterPool(settings, { allowFreeLite });
    const slices = partitionEvidence(
      notes.map((note) => note.id),
      plan.sides.length,
      plan.sides.map((side) => side.evidenceNoteIds ?? []),
    );
    const judgeModel = settings.provider === "mock" ? "mock-judge" : settings.judgeModel;
    debateId = await insertDebate(db, {
      userId,
      question: plan.question,
      judgeModel,
      jobId,
      mockEra: settings.provider === "mock",
      triggeredByDebateId: opts.trigger?.debateId ?? null,
      triggeredByFeedbackId: opts.trigger?.feedbackId ?? null,
    });
    const sides: { id: string; argument: string; model: string; uncomfortable: boolean; position: string }[] = [];
    for (let index = 0; index < plan.sides.length; index += 1) {
      const side = plan.sides[index];
      const evidenceNotes = notes.filter((note) => slices[index].includes(note.id));
      const resolved = resolveRoleModel(settings, { role: "debater", debaterIndex: index, allowFreeLite });
      const savedId = await insertDebateSide(db, {
        debateId,
        position: side.position,
        model: resolved.model,
        provider: resolved.provider,
        uncomfortable: side.uncomfortable,
        evidenceNoteIds: slices[index],
      });
      const argued = await completeJson(
        db,
        userId,
        ai,
        {
          role: "debater",
          debaterIndex: index,
          system: debaterPrompt({
            soul: soul.content,
            position: side.position,
            evidence: renderNotes(evidenceNotes),
            uncomfortable: side.uncomfortable,
            hisWords,
          }),
          messages: [{ role: "user", content: "Argue your position." }],
        },
        argumentSchema,
        meta,
      );
      sides.push({ id: savedId, argument: argued.argument, model: resolved.model, uncomfortable: side.uncomfortable, position: side.position });
      await updateDebateSide(db, savedId, { argument: argued.argument, prediction: argued.prediction });
    }
    const secrets = sides.map((side) => side.model);
    const labeled = shuffle(sides, rng).map((side, index) => ({
      sideId: side.id,
      label: "ABCD"[index],
      text: scrubArgument(side.argument, secrets),
      model: side.model,
    }));
    for (const item of labeled) {
      const side = sides.find((entry) => entry.id === item.sideId);
      if (side) await updateDebateSide(db, item.sideId, { argument: side.argument, anonymousLabel: item.label });
    }
    const judgment = await completeJson(
      db,
      userId,
      ai,
      {
        role: "judge",
        system: judgePrompt({
          soul: soul.content,
          question: plan.question,
          argumentsText: labeled.map((item) => `ARGUMENT ${item.label}\n${item.text}`).join("\n"),
          hisWords,
        }),
        messages: [{ role: "user", content: "Pick a winner." }],
      },
      judgmentSchema,
      meta,
    );
    const winner = labeled.find((item) => item.label === judgment.winner);
    if (!winner) throw new Error("Judge picked a label that was not in the debate.");
    const winnerSide = sides.find((side) => side.id === winner.sideId);
    const samples = await listFeedback(db, userId);
    const openPredictions = (await listPredictions(db, userId)).filter((item) => item.cameTrue == null);
    const openConflicts = (await listConflicts(db, userId)).filter((item) => !item.resolvedAt);
    const neverAsk = (await listInfoRequests(db, userId)).filter((item) => item.status === "never");
    const verbatim = [opts.trigger?.feedback ?? "", ...dumps.map((dump) => dump.content)].filter((item) => item.trim().length > 0);
    let unscored = "";
    if (opts.trigger) {
      const prior = await db.query(
        `SELECT prediction FROM reaction_predictions WHERE user_id = $1 AND subject_id = $2 AND score IS NULL ORDER BY created_at DESC LIMIT 1`,
        [userId, opts.trigger.debateId],
      );
      unscored = prior.rows[0] ? String(prior.rows[0].prediction) : "";
    }
    const claims = await listClaims(db, userId);
    const outcome = await completeJson(
      db,
      userId,
      ai,
      {
        role: "reflection",
        system: commitPrompt({
          soul: soul.content,
          question: plan.question,
          winner: winnerSide?.position ?? winner.text,
          why: judgment.why,
          loserGotRight: judgment.loserGotRight,
          notes: noteText,
          samples: samples.map((sample) => `sample:${sample.id} ${sample.content}`).join("\n"),
          predictions: openPredictions.map((item) => `prediction:${item.id} ${item.prediction}`).join("\n"),
          conflicts: openConflicts.map((item) => `${item.id}: ${item.description}`).join("\n"),
          neverAsk: neverAsk.map((item) => String(item.question)).join("\n"),
          claims: claims.map((claim) => `${claim.id} [${claim.status}] ${claim.statement}`).join("\n"),
        }),
        messages: [{ role: "user", content: unscored ? `UNSCORED PREDICTION:\n${unscored}\nEND UNSCORED PREDICTION\nHe has now responded. Score it, then commit.` : "Commit." }],
      },
      reflectionOutcomeSchema,
      {
        ...meta,
        reject: (text) => {
          try {
            const data = reflectionOutcomeSchema.parse(extractJson(text));
            for (const section of data.soul?.sections ?? []) {
              const copied = copiedPhrase(`${section.heading}\n${section.body}`, verbatim);
              if (copied) return `The soul copied his words ("${copied}"). Write a general principle and keep the quote as evidence.`;
            }
            for (const ask of data.infoRequests ?? []) {
              const problem = askProblem(ask);
              if (problem) return problem;
            }
            return null;
          } catch {
            return "missing commitment";
          }
        },
      },
    );
    const soulBefore = soul.version;
    const soulVersion = await applyOutcome(db, userId, debateId, outcome, opts.causingMessageId);
    if (soulVersion > soulBefore && opts.trigger) {
      await insertEvidenceQuote(db, userId, { debateId, quote: opts.trigger.feedback, source: "feedback", sourceId: opts.trigger.feedbackId });
    }
    const lessons = [...judgment.lessons];
    const loser = judgment.loserGotRight.trim();
    const covered = lessons.some((lesson) => loser && (lesson.text.includes(loser.slice(0, 48)) || loser.includes(lesson.text.slice(0, 48))));
    if (loser && !covered) lessons.push({ text: loser, destination: looksLikeAction(loser) ? "action" : "memory" });
    for (const lesson of lessons) {
      const lessonId = await insertLesson(db, userId, {
        debateId,
        text: lesson.text,
        destination: lesson.destination,
        soulVersion: lesson.destination === "soul" && soulVersion > soulBefore ? soulVersion : null,
      });
      if (lesson.destination === "action" || lesson.destination === "memory") {
        await insertCarried(db, userId, { debateId, lessonId, kind: lesson.destination, text: lesson.text });
      }
    }
    await writeBehaviorPrinciples(db, userId, debateId, lessons.filter((lesson) => lesson.destination === "behavior").map((lesson) => lesson.text), verbatim);
    await concludeDebate(db, debateId, {
      status: "concluded",
      winnerSideId: winner.sideId,
      winnerModel: winner.model,
      whyWon: judgment.why,
      loserGotRight: judgment.loserGotRight,
      closeCall: judgment.closeCall,
      commitment: outcome.commitment,
    });
    await markQueueHandled(db, userId);
    await logAction(db, userId, {
      what: "debate concluded",
      why: judgment.why,
      source: "judge",
      payload: { debateId, winner: judgment.winner, closeCall: judgment.closeCall },
    });
    const distinctModels = new Set(sides.map((side) => side.model));
    const report = [
      `Question: ${plan.question}`,
      `Winner: ${winnerSide?.position}`,
      `Why: ${judgment.why}`,
      `Loser got right: ${judgment.loserGotRight}`,
      `Commitment: ${outcome.commitment}`,
      distinctModels.size < sides.length ? "Debaters did not all have different models. The judge model was still kept out of the debate." : "Debaters ran on different models.",
    ].join("\n");
    await finishJob(db, jobId, "done", report);
    await recordReaction(db, userId, {
      subjectKind: "debate",
      subjectId: debateId,
      prediction: outcome.hisReaction || "He will say whether this commitment fits the way he decides.",
    });
    if (opts.trigger && outcome.predictionScore) {
      await scoreReaction(db, userId, opts.trigger.debateId, opts.trigger.feedback, outcome.predictionScore);
    }
    return { debateId, soulVersion, commitment: outcome.commitment };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reflection failed.";
    if (debateId) await failDebate(db, debateId, message);
    await finishJob(db, jobId, "failed", message);
    await logAction(db, userId, { what: "reflection stopped", why: message, source: "reflection", payload: { jobId } });
    return { error: message, debateId };
  }
}
