// The rebuild's fresh start, by hand. It also runs once, automatically, at the first start of the rebuild.
//   npx tsx scripts/fresh-start.ts         archive the old web (once; a second run does nothing)
//   npx tsx scripts/fresh-start.ts --undo  bring back exactly the rows the fresh start archived
import { loadEnv } from "../server/env.js";
loadEnv();
const { createDb, migrate } = await import("../src/db.js");
const { migrateCore } = await import("../src/core/schema.js");
const { freshStartOnce, undoFreshStart } = await import("../src/core/fresh.js");
const db = await createDb();
await migrate(db);
await migrateCore(db);
if (process.argv.includes("--undo")) console.log("Brought back:", await undoFreshStart(db));
else console.log(await freshStartOnce(db));
await db.close();
