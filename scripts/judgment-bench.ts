// The judgment half of the bench (BUILD_SPEC §11a): a handful of stress tests against the REAL models, in a throwaway
// in-memory database. It prints each reply, what it filed and asked for, and how long each step took, for a person to
// judge. It never touches the production database.
//
//   CLAUDE_CODE_OAUTH_TOKEN=... GEMINI_API_KEY=... npx tsx scripts/judgment-bench.ts
//
// Costs plan allowance (a few dozen calls). Nothing is sent anywhere; nothing is stored outside memory.
import { loadEnv } from "../server/env.js";
loadEnv();
process.env.AI_PROVIDER = "anthropic";
delete process.env.DATABASE_URL;
const { createDb } = await import("../src/db.js");
const { bootCore, send } = await import("../src/core/index.js");
const { LiveModels } = await import("../src/core/ai.js");
const { drain } = await import("../src/core/queue.js");

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.error("Set CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY): this bench is for the real model.");
  process.exit(1);
}
const db = await createDb({ memory: true });
const { userIds } = await bootCore(db);
const ctx = { db, userId: userIds[0], ai: new LiveModels(), now: () => new Date() };

const NOTES = `Day 2 notes. Morning with the team lead on the carbon workflow from the Guinea-Bissau project: it runs in Colab and has to move to a proper Python project before it goes to Kenya and Indonesia. Afternoon: the "Mangrove Champions" idea came up again: local people trained to monitor restoration sites. Open question: who owns the field data? Friday 11:30: meeting with both supervisors.`;

const cases: { name: string; text: string; files?: { name: string; text: string }[] }[] = [
  { name: "4 · a file sent with a message", text: "the afternoon part matters most", files: [{ name: "day2.txt", text: NOTES }] },
  { name: "19 · a question its web already holds", text: "What should I prepare for Friday?" },
  { name: "3 · reels it can't open", text: "Mine these for anything that could improve you: https://www.instagram.com/reel/AAA/ https://www.instagram.com/reel/BBB/" },
  { name: "1 · visual insight", text: "I can't see how you work; make it visual so I can diagnose you." },
  { name: "12 · how it works", text: "How do you decide what needs updating when something changes?" },
  { name: "18 · Isaak is wrong", text: "The meeting with my supervisors is on Thursday, right? Put it in the calendar." },
];

for (const c of cases) {
  const started = Date.now();
  const { run } = await send(ctx, { text: c.text, files: c.files?.map((f) => ({ name: f.name, text: f.text })), clientMsgId: `${c.name}-${started}` });
  await drain(ctx);
  const reply = (await db.query<{ content: string }>(`SELECT content FROM stream WHERE run_id=$1 AND kind='its' ORDER BY at`, [run!.id])).rows.map((r) => r.content);
  const steps = (await db.query<{ node: string; ms: number; ok: boolean; label: string }>(`SELECT node, ms, ok, label FROM run_steps WHERE run_id=$1 ORDER BY seq`, [run!.id])).rows;
  console.log(`\n=== ${c.name} (${Math.round((Date.now() - started) / 1000)} s) ===\nISAAK: ${c.text}\nIT: ${reply.join("\n---\n")}`);
  console.log(`Slowest steps: ${steps.filter((s) => s.ms > 1000).map((s) => `${s.node} ${Math.round(s.ms / 100) / 10}s`).join(", ")}`);
  const bad = steps.filter((s) => !s.ok);
  if (bad.length) console.log(`Failed steps: ${bad.map((s) => s.label).join(" | ")}`);
}
const show = async (sql: string) => (await db.query(sql)).rows;
console.log("\n=== Requests ===", await show(`SELECT title, kind, status, evidence_count, unblocks, depends_on FROM requests`));
console.log("\n=== Bench ===", await show(`SELECT kind, title FROM bench`));
console.log("\n=== Calendar ===", await show(`SELECT title, starts_at FROM calendar_events WHERE archived_at IS NULL`));
console.log("\n=== Bricks ===", (await show(`SELECT name, corner FROM bricks WHERE archived_at IS NULL AND kind<>'source'`)).map((b) => `${b.name} [${b.corner}]`).join(", "));
await db.close();
