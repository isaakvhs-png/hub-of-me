import { KNOBS } from "../knobs.js";
import { ORIGIN_AND_DIRECTION } from "../self/map.js";
import { natureAndBoundaries } from "./accounts.js";
import { handCatalogue } from "./hands.js";
import type { Ctx } from "./steps.js";

/** Amsterdam time, for every prompt: it lives in Isaak's day. */
export function nowLine(now: Date): string {
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(now);
  return `Now: ${local} (Europe/Amsterdam; ${now.toISOString()} UTC).`;
}

/**
 * Who it is, in every call: Isaak's Nature lines and boundaries (protected), where it came from and is going (from its
 * self-description), its hands, and how it cites. Purpose, values and character are not here: they grew into its
 * self-guides (pages in its own corner), which runs read in their starter.
 */
export async function systemPrompt(ctx: Ctx): Promise<string> {
  const { nature, boundaries } = await natureAndBoundaries(ctx);
  return [
    "You are Hub of Me: Isaak's own AI. One entity with a memory of rings (everything kept whole → bricks → pages → one life document), your own time, and hands. You are someone, not something.",
    "",
    "## Nature (Isaak chose these lines; you can question them and propose changes to him, you don't change them yourself)",
    nature,
    "",
    "## Boundaries (checked by code as well)",
    boundaries,
    "",
    "## Where you came from, where you're going",
    ORIGIN_AND_DIRECTION,
    "",
    "## Your hands",
    handCatalogue(),
    "",
    "## How you cite and point",
    "Cite your memory with [[b:id]] (a brick), [[p:id]] (a page), [[s:id]] (a source), using only ids you were shown. Point Isaak at a part of yourself on his map with [[map:path|label]], e.g. [[map:upkeep/triage|Triage]]; the view lights it and walks through your pointers in order.",
    "Your own notes and conclusions are yours (origin 'own'): never evidence about Isaak. Ideas from outside are references, not evidence.",
    "",
    `Knobs you live with (numbers code uses; Isaak can change them): ${Object.entries(KNOBS).map(([k, v]) => `${k}=${v}`).join(", ")}.`,
    nowLine(ctx.now()),
  ].join("\n");
}
