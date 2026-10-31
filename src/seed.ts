import type { Db } from "./db.js";
import { DEFAULT_USD_TO_EUR } from "./prices.js";
import { hashPassword } from "./password.js";
import { ensureFolderPath, getUserByEmail, insertBudget, insertSettings, insertUser } from "./repo.js";
import { changeSoul } from "./soul.js";
import { SEED_SOUL } from "./soul-seed.js";
import type { ProviderName, User } from "./types.js";

export async function ensureUser(
  db: Db,
  opts?: { email?: string; password?: string; name?: string; provider?: ProviderName },
): Promise<User> {
  const email = (opts?.email ?? process.env.USER_EMAIL ?? "peter@local").toLowerCase();
  const existing = await getUserByEmail(db, email);
  if (existing) return existing;
  const password = opts?.password ?? process.env.USER_PASSWORD ?? "hub-of-me";
  const name = opts?.name ?? process.env.USER_NAME ?? "Peter";
  const provider = (opts?.provider ?? (process.env.AI_PROVIDER as ProviderName) ?? "mock") as ProviderName;
  const user = await insertUser(db, { email, name, passwordHash: await hashPassword(password) });
  const usdToEur = Number(process.env.USD_TO_EUR ?? DEFAULT_USD_TO_EUR);
  await insertSettings(db, {
    userId: user.id,
    provider: provider === "anthropic" || provider === "gemini" || provider === "mock" ? provider : "mock",
    cheapModel: "anthropic:claude-haiku-5-5",
    strongModel: "anthropic:claude-sonnet-5-5",
    judgeModel: "anthropic:claude-sonnet-5-5",
    alternateModel: "gemini:gemini-2.5-flash",
    localCategories: [],
    forNowTtlHours: 72,
    dictationLang: "",
    priceOverrides: {},
    usdToEur: Number.isFinite(usdToEur) ? usdToEur : DEFAULT_USD_TO_EUR,
  });
  const cap = Number(process.env.MONTHLY_CAP_EUR_CENTS ?? 2000);
  await insertBudget(db, user.id, Number.isFinite(cap) ? cap : 2000);
  await ensureFolderPath(db, user.id, "Inbox");
  await changeSoul(db, user.id, {
    content: SEED_SOUL,
    reason: "Opening draft. The philosophy is here. His life is still blank.",
    via: "seed",
  });
  return user;
}
