import type { Router } from "./ai/router.js";
import type { Db } from "./db.js";
import { runReflection } from "./pipeline/debate.js";
import {
  claimNextDebateFeedback,
  finishDebateFeedback,
  getDebate,
  getSoul,
  type DebateFeedback,
} from "./repo.js";

const chains = new Map<string, Promise<void>>();

async function foldOne(db: Db, ai: Router, userId: string, item: DebateFeedback): Promise<void> {
  const source = await getDebate(db, userId, item.debateId);
  const before = await getSoul(db, userId);
  try {
    const result = await runReflection(db, ai, userId, {
      cause: `You gave feedback on “${String(source?.question ?? "a debate")}”. The conclusion already stands; this folds the reaction in.`,
      trigger: {
        debateId: item.debateId,
        feedbackId: item.id,
        feedback: item.body,
        question: String(source?.question ?? ""),
      },
    });
    const after = await getSoul(db, userId);
    const changed = Boolean(after && before && after.version > before.version);
    await finishDebateFeedback(db, item.id, {
      status: "error" in result ? "failed" : "done",
      ledToDebateId: result.debateId,
      soulVersion: changed && after ? after.version : null,
      soulReason: changed && after ? after.reason : null,
      error: "error" in result ? result.error : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feedback was not folded in.";
    await finishDebateFeedback(db, item.id, { status: "failed", error: message });
  }
}

async function drain(db: Db, userId: string, aiFor: () => Promise<Router>): Promise<void> {
  for (;;) {
    const item = await claimNextDebateFeedback(db, userId);
    if (!item) return;
    const ai = await aiFor();
    await foldOne(db, ai, userId, item);
  }
}

/** Serial per user. A second comment waits in the queue instead of starting a parallel reflection. */
export function scheduleFeedbackDrain(db: Db, userId: string, aiFor: () => Promise<Router>): void {
  const prev = chains.get(userId) ?? Promise.resolve();
  const next = prev.then(
    () => drain(db, userId, aiFor),
    () => drain(db, userId, aiFor),
  );
  chains.set(userId, next);
  void next.then(
    () => undefined,
    (error) => console.error("feedback queue", error),
  );
}
