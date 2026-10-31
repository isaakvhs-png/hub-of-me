import { createDb, migrate, type Db } from "../src/db.js";
import { MockProvider } from "../src/ai/mock.js";
import { Router } from "../src/ai/router.js";
import { ensureUser } from "../src/seed.js";
import { getSettings } from "../src/repo.js";
import type { User } from "../src/types.js";

export async function fresh(): Promise<{ db: Db; user: User; ai: Router; mock: MockProvider }> {
  const db = await createDb({ memory: true });
  await migrate(db);
  const user = await ensureUser(db, { email: "peter@test", password: "secret", name: "Peter", provider: "mock" });
  const settings = await getSettings(db, user.id);
  const mock = new MockProvider();
  const ai = new Router(settings, { mock });
  return { db, user, ai, mock };
}
