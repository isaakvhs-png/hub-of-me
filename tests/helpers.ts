import { createDb, migrate, type Db } from "../src/db.js";
import { setDb } from "../src/state.js";
import { setMock } from "../src/models.js";
import { scriptedModel, mockState } from "../src/mock.js";
import { boot } from "../src/boot.js";
import { oneStep, resetThinkForTests } from "../src/autonomy.js";

export async function fresh(): Promise<Db> {
  const db = await createDb({ memory: true });
  await migrate(db);
  setDb(db);
  setMock(scriptedModel);
  mockState.judge = "junction"; mockState.straying = false; mockState.proposeOnce = true;
  resetThinkForTests();
  process.env.USER_EMAIL = "isaak@test"; process.env.USER_PASSWORD = "pw";
  await boot({ autonomy: false });
  return db;
}

/** Its own work, step by step, until there is nothing left (or a cap). */
export async function drain(max = 60): Promise<number> {
  let n = 0;
  while (n < max && (await oneStep())) n += 1;
  return n;
}
