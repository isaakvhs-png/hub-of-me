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
  destination: z.enum(["soul", "action", "memory"]),
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
      }),
    )
    .optional(),
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
