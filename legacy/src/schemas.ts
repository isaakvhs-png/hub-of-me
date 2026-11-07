import { z } from "zod";
import { NOTE_TYPES } from "./types.js";

export const filingNoteSchema = z.object({
  type: z.enum(NOTE_TYPES),
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  folder: z.string().min(1).max(200),
  status: z.enum(["unexplored", "for_now"]),
  forNowHours: z.number().positive().max(24 * 30).optional(),
  flagForReflection: z.boolean(),
  flagForSoul: z.boolean(),
  contradicts: z.boolean().optional(),
  contradictionWith: z.string().optional(),
});

export const filingSchema = z.object({
  notes: z.array(filingNoteSchema).min(1).max(12),
  sources: z
    .array(
      z.object({
        title: z.string().min(1),
        url: z.string().optional(),
        excerpt: z.string().optional(),
      }),
    )
    .optional(),
  tasks: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        why: z.string().min(1),
        owner: z.enum(["peter", "system"]),
        due: z.string().optional(),
        surfaced: z.boolean().optional(),
        whyNow: z.string().optional(),
      }),
    )
    .max(12)
    .optional(),
  closeTaskIds: z.array(z.string()).max(12).optional(),
  fade: z.array(z.object({ taskId: z.string().min(1), reason: z.string().min(1) })).max(12).optional(),
});

export const traceSchema = z.object({
  spans: z.array(
    z.object({
      phrase: z.string().min(1),
      destination: z.enum(["picture", "world", "followup", "soul", "debate", "behavior", "memory"]),
      label: z.string().min(1).max(160),
      situations: z.string().max(200).optional(),
    }),
  ),
});

export const claimUpdateSchema = z.object({
  claimId: z.string().min(1).optional(),
  statement: z.string().min(1),
  situations: z.string().optional(),
  status: z.enum(["tentative", "held", "revised", "dropped"]).optional(),
  evidence: z
    .array(
      z.object({
        quote: z.string().min(1),
        source: z.string().min(1),
      }),
    )
    .optional(),
});

export const reactionScoreSchema = z.object({
  score: z.enum(["hit", "miss", "partial"]),
  claimUpdates: z.array(claimUpdateSchema).optional(),
});

export const mindNoteSchema = z.object({
  note: z.string().min(1),
  coversPeter: z.boolean(),
  coversWorld: z.boolean(),
  coversItself: z.boolean(),
  quiet: z.array(z.enum(["peter", "world", "itself"])),
  quietWhy: z.string().optional(),
});

export const criticSchema = z.object({
  ok: z.boolean(),
  problem: z.string().optional(),
});

export const debatePlanSchema = z
  .object({
    question: z.string().min(1),
    sides: z
      .array(
        z.object({
          position: z.string().min(1),
          uncomfortable: z.boolean(),
          evidenceNoteIds: z.array(z.string()).optional(),
        }),
      )
      .min(2)
      .max(4),
  })
  .superRefine((value, ctx) => {
    if (!value.sides.some((side) => side.uncomfortable)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "one side must argue the uncomfortable position" });
    }
  });

export const argumentSchema = z.object({
  argument: z.string().min(1),
  prediction: z.string().optional(),
});

export const lessonSchema = z.object({
  text: z.string().min(1),
  destination: z.enum(["soul", "action", "memory", "behavior"]),
});

export const judgmentSchema = z.object({
  winner: z.string().regex(/^[A-D]$/),
  why: z.string().min(1),
  loserGotRight: z.string().min(1),
  closeCall: z.boolean(),
  lessons: z.array(lessonSchema).min(1),
});

export const reflectionOutcomeSchema = z.object({
  commitment: z.string().min(1),
  hisReaction: z.string().min(1).optional(),
  predictionScore: z.enum(["hit", "miss", "partial"]).optional(),
  soul: z
    .object({
      reason: z.string().min(1),
      sections: z.array(z.object({ heading: z.string().min(1), body: z.string().min(1) })).min(1),
    })
    .optional(),
  picture: z
    .array(
      z.object({
        statement: z.string().min(1),
        evidenceNoteIds: z.array(z.string()),
      }),
    )
    .optional(),
  preferenceRules: z
    .array(
      z.object({
        statement: z.string().min(1),
        evidenceSampleIds: z.array(z.string()),
      }),
    )
    .optional(),
  infoRequests: z
    .array(
      z.object({
        subject: z.string().min(1),
        question: z.string().min(1),
        context: z.string().min(1),
        why: z.string().min(1),
        expect: z.string().min(1).optional(),
      }),
    )
    .optional(),
  claimUpdates: z.array(claimUpdateSchema).optional(),
  evidence: z
    .array(
      z.object({
        quote: z.string().min(1),
        source: z.enum(["feedback", "dump", "note"]),
      }),
    )
    .optional(),
  predictions: z.array(z.string().min(1)).optional(),
  predictionChecks: z
    .array(
      z.object({
        id: z.string().min(1),
        cameTrue: z.boolean(),
        observed: z.string().min(1),
      }),
    )
    .optional(),
  conflictsResolved: z
    .array(
      z.object({
        conflictId: z.string().min(1),
        resolution: z.string().min(1),
      }),
    )
    .optional(),
});

export const researchSchema = z.object({
  query: z.string().min(1),
  finding: z.string().min(1),
  sources: z.array(
    z.object({
      title: z.string().min(1),
      url: z.string().optional(),
      excerpt: z.string().optional(),
    }),
  ),
});

export const dutiesSchema = z.object({
  events: z.array(
    z.object({
      title: z.string().min(1),
      startsAt: z.string().min(1),
      endsAt: z.string().min(1),
      why: z.string().min(1),
    }),
  ),
  drafts: z.array(
    z.object({
      to: z.string(),
      subject: z.string(),
      body: z.string().min(1),
    }),
  ),
  archives: z.array(
    z.object({
      noteId: z.string().min(1),
      why: z.string().min(1),
    }),
  ),
});

export type FilingForm = z.infer<typeof filingSchema>;
export type DebatePlan = z.infer<typeof debatePlanSchema>;
export type Judgment = z.infer<typeof judgmentSchema>;
export type ReflectionOutcome = z.infer<typeof reflectionOutcomeSchema>;
export type ResearchForm = z.infer<typeof researchSchema>;
export type DutiesForm = z.infer<typeof dutiesSchema>;
