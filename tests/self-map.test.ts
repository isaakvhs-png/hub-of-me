import { describe, it, expect } from "vitest";
import { SYSTEM_MAP, mapPaths, mapNode } from "../src/self/map";

describe("system map (its self-description)", () => {
  it("has the twelve parts", () => {
    expect(Object.keys(SYSTEM_MAP.kids!).sort()).toEqual(
      ["build","hands","intake","queue","requests","review","run","sources","upkeep","web","workshop","you"].sort());
  });
  it("every edge points at a node in its container or at a top-level part", () => {
    const top = new Set(Object.keys(SYSTEM_MAP.kids!));
    const walk = (n: typeof SYSTEM_MAP) => {
      for (const [a, b] of n.edges ?? []) for (const x of [a, b]) {
        if (x.startsWith("@")) expect(top.has(x.slice(1))).toBe(true);
        else expect(n.kids?.[x], `${n.t}: ${x}`).toBeDefined();
      }
      for (const k of Object.values(n.kids ?? {})) walk(k);
    };
    walk(SYSTEM_MAP);
  });
  it("finds nodes by path", () => {
    expect(mapNode("run/gather/gplan")?.t).toBe("Its list");
    expect(mapPaths()).toContain("upkeep/routes/rflag");
  });
});
