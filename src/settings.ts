import { ValidationError } from "./errors.js";
import { db } from "./state.js";
import { modelStatus } from "./models.js";

/**
 * The settings tab (Isaak, 15 Nov): knobs, how much of Render's monthly free hours are left and when they reset, how much
 * database space is left, and the model limits.
 */

export const KNOBS = {
  ownWork: { label: "Its own work runs", type: "bool", default: true },
  dbLimitMb: { label: "Database space you have (MB)", type: "number", default: 1024 },
  renderHours: { label: "Render free hours per month", type: "number", default: 750 },
} as const;
export type KnobName = keyof typeof KNOBS;

export async function getKnob<K extends KnobName>(name: K): Promise<(typeof KNOBS)[K]["default"]> {
  const r = await db().query<{ value: string }>(`SELECT value FROM meta WHERE key = $1`, [`knob:${name}`]);
  if (!r.rows[0]) return KNOBS[name].default;
  try { return JSON.parse(r.rows[0].value); } catch { return KNOBS[name].default; }
}

export async function setKnob(name: string, value: unknown): Promise<void> {
  if (!(name in KNOBS)) throw new ValidationError(`There is no knob called ${name}.`);
  const knob = KNOBS[name as KnobName];
  const v = knob.type === "bool" ? Boolean(value) : Math.max(0, Number(value) || 0);
  await db().query(`INSERT INTO meta (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [`knob:${name}`, JSON.stringify(v)]);
}

const monthKey = (d = new Date()) => `awake:${d.toISOString().slice(0, 7)}`;

/** Every minute it is awake it counts a minute: that is what Render's free hours measure for this site. */
export async function heartbeat(): Promise<void> {
  await db().query(`INSERT INTO meta (key, value) VALUES ($1,'1') ON CONFLICT (key) DO UPDATE SET value = (meta.value::int + 1)::text`, [monthKey()]);
}

export async function settingsView() {
  const knobs: Record<string, unknown> = {};
  for (const name of Object.keys(KNOBS) as KnobName[]) knobs[name] = { ...KNOBS[name], value: await getKnob(name) };
  const minutes = Number((await db().query<{ value: string }>(`SELECT value FROM meta WHERE key = $1`, [monthKey()])).rows[0]?.value ?? 0);
  const now = new Date();
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const budget = Number(await getKnob("renderHours"));
  let dbBytes = 0;
  try { dbBytes = Number((await db().query<{ n: string }>(`SELECT pg_database_size(current_database()) AS n`)).rows[0]?.n ?? 0); } catch { /* unknown */ }
  const limitMb = Number(await getKnob("dbLimitMb"));
  const calls = await db().query<{ model: string; n: string; failed: string; chars: string }>(
    `SELECT model, count(*) AS n, sum(CASE WHEN ok THEN 0 ELSE 1 END) AS failed, sum(chars_in + chars_out) AS chars FROM calls WHERE created_at > now() - interval '24 hours' GROUP BY model ORDER BY n DESC`);
  return {
    knobs,
    render: { hoursUsed: Math.round((minutes / 60) * 10) / 10, hoursBudget: budget, hoursLeft: Math.max(0, Math.round((budget - minutes / 60) * 10) / 10), resetsAt: reset.toISOString(), note: "Counted by the site itself: the minutes it was awake this month." },
    database: { usedMb: Math.round((dbBytes / 1048576) * 10) / 10, limitMb, leftMb: Math.max(0, Math.round((limitMb - dbBytes / 1048576) * 10) / 10) },
    models: { ...modelStatus(), last24h: calls.rows.map((c) => ({ model: c.model, calls: Number(c.n), failed: Number(c.failed), chars: Number(c.chars) })) },
  };
}
