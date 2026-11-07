import type { Db } from "./db.js";
import { DEFAULT_USD_TO_EUR } from "./prices.js";
import { hashPassword } from "./password.js";
import { readEnvProvider } from "./ai/router.js";
import { ensureFolderPath, getSettings, getUserByEmail, insertBudget, insertSettings, insertUser, listUsers, updateSettings, updateUserAccount } from "./repo.js";
import { changeSoul } from "./soul.js";
import { SEED_SOUL } from "./soul-seed.js";
import type { ProviderName, User } from "./types.js";

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export async function ensureUser(
  db: Db,
  opts?: { email?: string; password?: string; name?: string; provider?: ProviderName },
): Promise<User> {
  const envEmail = envValue("USER_EMAIL")?.toLowerCase();
  const envPassword = envValue("USER_PASSWORD");
  // A name typed in capitals ("ISAAK") is meant as a name, not a shout: store it as "Isaak".
  const rawName = envValue("USER_NAME");
  const envName = rawName && rawName === rawName.toUpperCase() && /[A-Z]/.test(rawName)
    ? rawName.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_m, pre: string, ch: string) => pre + ch.toUpperCase())
    : rawName;
  // Server start calls this with no opts. When both credentials are set, rewrite the one account in place.
  if (!opts && envEmail && envPassword) {
    const users = await listUsers(db);
    if (users.length === 1) {
      const current = users[0];
      return updateUserAccount(db, current.id, {
        email: envEmail,
        // "Peter" was a wrong default from early builds; the person is Isaak.
        name: envName ?? (current.name === "Peter" ? "Isaak" : current.name),
        passwordHash: await hashPassword(envPassword),
      });
    }
  }
  const email = (opts?.email ?? envEmail ?? "peter@local").toLowerCase();
  const existing = await getUserByEmail(db, email);
  if (existing) return existing;
  const password = opts?.password ?? envPassword ?? "hub-of-me";
  const name = opts?.name ?? envName ?? "Isaak";
  const provider = opts?.provider ?? readEnvProvider().normalized ?? "mock";
  const user = await insertUser(db, { email, name, passwordHash: await hashPassword(password) });
  const usdToEur = Number(process.env.USD_TO_EUR ?? DEFAULT_USD_TO_EUR);
  await insertSettings(db, {
    userId: user.id,
    provider: provider === "anthropic" || provider === "gemini" || provider === "mock" ? provider : "mock",
    cheapModel: "anthropic:claude-haiku-5-5",
    strongModel: "anthropic:claude-sonnet-5-5",
    judgeModel: "anthropic:claude-sonnet-5-5",
    alternateModel: "gemini:gemini-3.5-flash-lite",
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

/** On every start, a recognized AI_PROVIDER replaces the stored Settings provider. */
export async function applyEnvProvider(db: Db): Promise<void> {
  const env = readEnvProvider();
  if (!env.normalized) {
    if (env.raw) console.warn(`AI_PROVIDER "${env.raw}" is not mock, anthropic, or gemini. Stored provider left as-is.`);
    return;
  }
  const users = await listUsers(db);
  if (users.length !== 1) return;
  const settings = await getSettings(db, users[0].id);
  if (settings.provider === env.normalized) return;
  await updateSettings(db, { ...settings, provider: env.normalized });
  console.log(`Settings provider updated from ${settings.provider} to ${env.normalized} because AI_PROVIDER is set.`);
}
