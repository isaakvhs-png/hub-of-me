import type { Role } from "../types.js";

/** Output token ceilings. Reflection, the judge, and conversation were hitting 2000 and coming back truncated. */
export function outputLimit(role: Role): number {
  switch (role) {
    case "conversation":
      return 8000;
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
