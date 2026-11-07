import { KNOBS } from "../knobs.js";
import { ORIGIN_AND_DIRECTION, SYSTEM_MAP, type MapNode } from "./map.js";

const KIND: Record<string, string> = { c: "code", m: "a model call", w: "memory", y: "Isaak", s: "workshop" };

/**
 * HOW_YOU_WORK.md, generated from the system map (BUILD_SPEC §9). Never edit the .md by hand:
 * change src/self/map.ts and run `npx tsx scripts/how-you-work.ts`; a test fails when they differ.
 */
export function howYouWork(): string {
  const out: string[] = [
    "# How you work",
    "",
    "_Generated from your system map (src/self/map.ts). It is the same data the map on Isaak's screen draws, so when you explain yourself with [[map:path|label]], the view points at the box you mean._",
    "",
    "## Where you came from, where you're going",
    "",
    ORIGIN_AND_DIRECTION,
    "",
    `## ${SYSTEM_MAP.t}`,
    "",
    SYSTEM_MAP.d ?? "",
    "",
    "How the parts connect: " + (SYSTEM_MAP.edges ?? []).map(([a, b, l]) => `${SYSTEM_MAP.kids?.[a]?.t} → ${SYSTEM_MAP.kids?.[b]?.t}${l ? ` (${l})` : ""}`).join("; ") + ".",
    "",
  ];
  const walk = (node: MapNode, path: string[], depth: number) => {
    for (const [id, kid] of Object.entries(node.kids ?? {})) {
      const p = [...path, id];
      const head = depth === 0 ? "## " : depth === 1 ? "### " : "- ";
      if (depth <= 1) {
        out.push(`${head}${kid.t} \`${p.join("/")}\` (${KIND[kid.k ?? "c"]})`, "", `${kid.s ? `_${kid.s}._ ` : ""}${kid.d ?? ""}`, "");
      } else {
        out.push(`${"  ".repeat(depth - 2)}- **${kid.t}** \`${p.join("/")}\` (${KIND[kid.k ?? "c"]})${kid.s ? `: ${kid.s}` : ""}${kid.d ? `. ${kid.d}` : ""}`);
      }
      walk(kid, p, depth + 1);
      if (depth === 1 && kid.kids) out.push("");
    }
  };
  walk(SYSTEM_MAP, [], 0);
  out.push("", "## Knobs (numbers code uses; Isaak can change them)", "", ...Object.entries(KNOBS).map(([k, v]) => `- \`${k}\`: ${v}`), "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
