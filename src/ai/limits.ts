import type { Role } from "../types.js";

/** Output token ceilings. Reflection, the judge, and conversation were hitting 2000 and coming back truncated. */
export function outputLimit(role: Role): number {
  switch (role) {
    case "conversation":
      // Taking in a long message writes portrait, self-portrait, map, intentions and notes in one step; 8000 cut it off.
      return 16000;
    case "judge":
      return 8000;
    case "reflection":
      return 16000;
    case "debater":
    case "filing":
    case "research":
    case "duties":
      return 4000;
    case "critic":
      return 2000;
    default:
      return 4000;
  }
}

export const OUTPUT_CEILING = 32000;
