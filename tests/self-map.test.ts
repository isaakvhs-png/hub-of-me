import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { SYSTEM_MAP, mapPaths, mapNode } from "../src/self/map";
import { howYouWork } from "../src/self/how";

describe("system map (its self-description)", () => {
  it("has the twelve parts", () => {
    expect(Object.keys(SYSTEM_MAP.kids!).sort()).toEqual(
      ["build","hands","intake","queue","requests","review","run","sources","upkeep","web","workshop","you"].sort());
  });
  it("finds nodes by path", () => {
    expect(mapNode("run/gather/gplan")?.t).toBe("Its list");
    expect(mapNode("nope/x")).toBeUndefined();
    expect(mapPaths().length).toBeGreaterThan(150);
  });
  it("every edge points at a node that exists", () => {
    const check = (node: typeof SYSTEM_MAP, path: string) => {
      for (const [a, b] of node.edges ?? []) for (const end of [a, b]) {
        if (end.startsWith("@")) expect(SYSTEM_MAP.kids![end.slice(1)], `${path}: ${end}`).toBeTruthy();
        else expect(node.kids?.[end], `${path}: ${end}`).toBeTruthy();
      }
      for (const [id, kid] of Object.entries(node.kids ?? {})) check(kid, path ? `${path}/${id}` : id);
    };
    check(SYSTEM_MAP, "");
  });
  it("every run_steps node the code writes is a path in the map", () => {
    const tops = Object.keys(SYSTEM_MAP.kids!).join("|");
    const known = new Set(mapPaths());
    const files = readdirSync("src/core").filter((f) => f.endsWith(".ts")).map((f) => join("src/core", f));
    const used = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(new RegExp(`"((?:${tops})/[A-Za-z/]+)"`, "g"))) used.add(m[1]);
    expect(used.size).toBeGreaterThan(40);
    expect([...used].filter((p) => !known.has(p))).toEqual([]);
  });
  it("HOW_YOU_WORK.md is generated from the map (run: npx tsx scripts/how-you-work.ts)", () => {
    expect(readFileSync("src/agent/HOW_YOU_WORK.md", "utf8")).toBe(howYouWork());
  });
});
