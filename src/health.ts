import type { Db } from "./db.js";
import { getBudget, getSettings, listDebates, listUsage, spendSince } from "./repo.js";
import { startOfMonth } from "./time.js";

export function judgeDrift(debates: { status: string; winnerModel: string | null; userFeedback: string | null }[]): { flagged: boolean; detail: string } {
  const concluded = debates.filter((debate) => debate.status === "concluded").slice(0, 6);
  if (concluded.length < 4) return { flagged: false, detail: "Not enough debates yet to look for one-sided drift." };
  const counts = new Map<string, number>();
  for (const debate of concluded) {
    const key = debate.winnerModel || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const disagreed = concluded.filter((debate) => debate.userFeedback && /no|wrong|disagree/i.test(debate.userFeedback)).length;
  if (top && top[1] === concluded.length && disagreed > 0) {
    return { flagged: true, detail: `${top[0]} won every recent debate, and a reaction disagreed.` };
  }
  return { flagged: false, detail: "No one-sided drift flagged." };
}

function group(rows: { key: string; inputTokens: number; outputTokens: number; costEurCents: number | null }[]) {
  const map = new Map<string, { key: string; calls: number; inputTokens: number; outputTokens: number; costEurCents: number }>();
  for (const row of rows) {
    const current = map.get(row.key) ?? { key: row.key, calls: 0, inputTokens: 0, outputTokens: 0, costEurCents: 0 };
    current.calls += 1;
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.costEurCents += row.costEurCents ?? 0;
    map.set(row.key, current);
  }
  return [...map.values()];
}

export async function healthReport(db: Db, userId: string) {
  const since = startOfMonth("Europe/Amsterdam");
  const [budget, settings, usage, debates, spend] = await Promise.all([
    getBudget(db, userId),
    getSettings(db, userId),
    listUsage(db, userId, since.toISOString()),
    listDebates(db, userId),
    spendSince(db, userId, since.toISOString()),
  ]);
  const dayKey = (isoDate: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(isoDate));
  return {
    monthStart: since.toISOString(),
    capEurCents: budget.monthlyCapEurCents,
    spentEurCents: spend.spentEurCents,
    leftEurCents: budget.monthlyCapEurCents - spend.spentEurCents,
    unpricedCalls: spend.unpriced,
    usdToEur: settings.usdToEur,
    calls: usage.length,
    inputTokens: usage.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: usage.reduce((sum, row) => sum + row.outputTokens, 0),
    byDay: group(usage.map((row) => ({ key: dayKey(row.createdAt), inputTokens: row.inputTokens, outputTokens: row.outputTokens, costEurCents: row.costEurCents }))),
    byConversation: group(
      usage.map((row) => ({ key: row.conversationId ?? "(no conversation)", inputTokens: row.inputTokens, outputTokens: row.outputTokens, costEurCents: row.costEurCents })),
    ),
    byJob: group(usage.map((row) => ({ key: row.jobKind ?? row.role, inputTokens: row.inputTokens, outputTokens: row.outputTokens, costEurCents: row.costEurCents }))),
    drift: judgeDrift(debates.map((debate) => ({ status: String(debate.status), winnerModel: debate.winnerModel as string | null, userFeedback: debate.userFeedback as string | null }))),
    winsByModel: debates.reduce<Record<string, number>>((acc, debate) => {
      if (debate.status !== "concluded" || !debate.winnerModel) return acc;
      const key = String(debate.winnerModel);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  };
}
