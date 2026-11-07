// Writes src/agent/HOW_YOU_WORK.md from the system map. Run after any change to src/self/map.ts or src/knobs.ts.
import { writeFileSync } from "node:fs";
import { howYouWork } from "../src/self/how.js";

writeFileSync("src/agent/HOW_YOU_WORK.md", howYouWork());
console.log("src/agent/HOW_YOU_WORK.md written from the system map.");
