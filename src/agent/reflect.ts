import { z } from "zod";
import type { Db } from "../db.js";
import type { Router } from "../ai/router.js";
import { completeJson } from "../ai/tracked.js";
import { getSoul, insertInfoRequest, logAction } from "../repo.js";
import { changeSoul, mergeSoulSections } from "../soul.js";
import { conversationView, memoryView, saveInner, saveMap } from "./memory.js";

const reflectionSchema = z.object({
  thoughts: z.string().min(1),
  soul: z
    .object({
      reason: z.string().min(1),
      sections: z.array(z.object({ heading: z.string().min(1), body: z.string() })).min(1),
    })
    .optional(),
  portrait: z.string().optional(),
  self_portrait: z.string().optional(),
  map: z.array(z.object({ name: z.string(), known: z.string().optional(), open: z.string().optional() })).optional(),
  intentions: z.string().optional(),
  asks: z
    .array(z.object({ subject: z.string().min(1), question: z.string().min(1), context: z.string().min(1), why: z.string().min(1) }))
    .optional(),
  mind: z.string().optional(),
});

/**
 * Quiet reflection: it steps back and thinks in its own words, with the model it chose, over everything it has in mind.
 * No sides, no judge, no required sentence. What it concludes can change its soul, its understanding of him, its intentions, and what it wants to ask.
 */
export async function reflectQuietly(
  db: Db,
  ai: Router,
  userId: string,
  input: { cause: string; model: string; causingMessageId?: string | null },
): Promise<string> {
  const soul = await getSoul(db, userId);
  if (!soul) return "There is no soul to reflect from.";
  const memory = await memoryView(db, userId);
  const conversation = await conversationView(db, userId, memory.conversationChars);
  const out = await completeJson(
    db,
    userId,
    ai,
    {
      role: "reflection",
      model: input.model,
      system: `TASK: reflect
You are stepping back to think, alone, in your own words. Nobody reads this but you and, if he looks, him.
Think about what you set out to think about. Use everything below. Notice what you don't know yet, what doesn't fit, and what is new ground.
Your character grows only from real moments like these. If something should change in how you are, write it in the soul as a general principle, not as his words or a rule. Nature and Boundaries are Isaak's: you cannot change them, but if you think one should change, ask him (as an ask) and say why.
Return one JSON object; every field except thoughts is optional:
{"thoughts":"what you now think, in your own words","soul":{"reason":"","sections":[{"heading":"","body":""}]},"portrait":"your whole portrait of him, rewritten","self_portrait":"your whole self-portrait, rewritten","map":[{"name":"","known":"","open":""}],"intentions":"what you are going for now, for yourself and with him, and why","asks":[{"subject":"","question":"","context":"","why":""}]}
Only return soul sections you are changing. An ask must make sense read cold: name its subject, why now, and what the answer would change.

WHAT YOU ARE THINKING ABOUT:
${input.cause}

SOUL:
${soul.content}

WHAT YOU HAVE IN MIND:
${memory.text}

${memory.own}

CONVERSATION:
${conversation}`,
      messages: [{ role: "user", content: "Think it through." }],
    },
    reflectionSchema,
    { jobKind: "reflection" },
  );
  const done: string[] = [];
  if (out.soul?.sections.length) {
    const sections = out.soul.sections.filter((section) => !["boundaries", "nature"].includes(section.heading.trim().toLowerCase()));
    if (sections.length) {
      try {
        const saved = await changeSoul(db, userId, {
          content: mergeSoulSections(soul.content, sections),
          reason: out.soul.reason,
          via: "reflection",
          causingMessageId: input.causingMessageId ?? null,
        });
        done.push(`soul version ${saved.version}`);
      } catch (error) {
        done.push(`soul unchanged (${error instanceof Error ? error.message : "refused"})`);
      }
    }
  }
  if (out.portrait?.trim() && (await saveInner(db, userId, "portrait", out.portrait, `Reflecting: ${input.cause}`))) done.push("portrait rewritten");
  if (out.self_portrait?.trim() && (await saveInner(db, userId, "self_portrait", out.self_portrait, `Reflecting: ${input.cause}`))) done.push("self-portrait rewritten");
  if (out.map?.length && (await saveMap(db, userId, out.map, `Reflecting: ${input.cause}`))) done.push("map redrawn");
  if (!out.intentions?.trim() && out.mind?.trim()) out.intentions = out.mind;
  if (out.intentions?.trim() && (await saveInner(db, userId, "intentions", out.intentions, `Reflecting: ${input.cause}`))) done.push("intentions updated");
  for (const ask of out.asks ?? []) {
    await insertInfoRequest(db, userId, { ...ask, rank: 0 });
    done.push(`asked: ${ask.question}`);
  }
  await logAction(db, userId, { what: "reflected", why: input.cause, source: "reflection", payload: { model: input.model, thoughts: out.thoughts.slice(0, 2000), done } });
  return `THOUGHTS: ${out.thoughts}${done.length ? `\nCHANGED: ${done.join("; ")}` : ""}`;
}
