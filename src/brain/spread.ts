import type { Db } from "../db.js";
import { id } from "../ids.js";
import { listBricks, listLinks, norm, type Brick, type Link } from "./store.js";

/**
 * Energy: what a message or a thought lights up. It starts at the bricks the text names, plus a small head start for
 * warm bricks, then spreads along links: stronger links pass on more, every step loses some, a little randomness keeps
 * it from always walking the same routes, and it stops where it gets too faint. It lasts one thought; warmth is what stays.
 */

export const SPREAD = { steps: 3, keep: 0.55, threshold: 0.08, noise: 0.15, warmHeadStart: 0.35, focus: 8, focusMin: 0.15 };

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "what", "about", "into", "your", "first", "learning", "project", "meeting"]);

/** Bricks the text itself names: the whole name, or a distinctive word of it (a surname, a place). */
export function seedsFor(text: string, bricks: Brick[]): Map<string, number> {
  const t = ` ${norm(text)} `;
  const seeds = new Map<string, number>();
  for (const b of bricks) {
    const n = norm(b.name);
    if (!n) continue;
    if (t.includes(` ${n} `)) { seeds.set(b.id, 1); continue; }
    const words = n.split(" ").filter((w) => w.length >= 5 && !STOP.has(w));
    if (words.some((w) => t.includes(` ${w} `))) seeds.set(b.id, Math.max(seeds.get(b.id) ?? 0, 0.8));
  }
  return seeds;
}

export function spread(bricks: Brick[], links: Link[], seeds: Map<string, number>, rand: () => number = Math.random): Map<string, number> {
  const energy = new Map<string, number>();
  for (const b of bricks) {
    const warm = b.warmth * SPREAD.warmHeadStart;
    const start = Math.max(seeds.get(b.id) ?? 0, warm);
    if (start >= SPREAD.threshold) energy.set(b.id, start);
  }
  const neighbours = new Map<string, { other: string; strength: number }[]>();
  for (const l of links) {
    (neighbours.get(l.a) ?? neighbours.set(l.a, []).get(l.a)!).push({ other: l.b, strength: l.strength });
    (neighbours.get(l.b) ?? neighbours.set(l.b, []).get(l.b)!).push({ other: l.a, strength: l.strength });
  }
  let frontier = [...energy.keys()];
  for (let step = 0; step < SPREAD.steps && frontier.length; step += 1) {
    const next: string[] = [];
    for (const from of frontier) {
      const e = energy.get(from) ?? 0;
      for (const { other, strength } of neighbours.get(from) ?? []) {
        const pass = e * SPREAD.keep * (strength / (strength + 1.5)) * (1 - SPREAD.noise + rand() * 2 * SPREAD.noise);
        if (pass < SPREAD.threshold) continue;
        if (pass > (energy.get(other) ?? 0)) {
          energy.set(other, Math.min(1, pass));
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return energy;
}

export interface Activation {
  energies: Map<string, number>;
  seeds: string[];
  focus: string[];
}

/** Light up the web for a text and keep the result, so he can see what it was thinking with. */
export async function activate(db: Db, userId: string, input: { text: string; cause: string; extraSeeds?: string[] }): Promise<Activation> {
  const [bricks, links] = await Promise.all([listBricks(db, userId), listLinks(db, userId)]);
  const seeds = seedsFor(input.text, bricks);
  for (const extra of input.extraSeeds ?? []) if (bricks.some((b) => b.id === extra)) seeds.set(extra, 1);
  const energies = spread(bricks, links, seeds);
  const focus = [...energies.entries()].filter(([, e]) => e >= SPREAD.focusMin).sort((a, b) => b[1] - a[1]).slice(0, SPREAD.focus).map(([k]) => k);
  await db.query(`INSERT INTO brain_activations (id, user_id, cause, energies) VALUES ($1,$2,$3,$4)`, [id(), userId, input.cause.slice(0, 200), JSON.stringify(Object.fromEntries(energies))]);
  return { energies, seeds: [...seeds.keys()], focus };
}

/** Record which bricks the thought actually used, on the latest activation. */
export async function recordUsed(db: Db, userId: string, used: string[]): Promise<void> {
  const row = (await db.query(`SELECT id FROM brain_activations WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0];
  if (row) await db.query(`UPDATE brain_activations SET used = $2 WHERE id = $1`, [row.id, JSON.stringify(used)]);
}
