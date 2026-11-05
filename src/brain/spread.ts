import type { Db } from "../db.js";
import { id } from "../ids.js";
import { listBricks, listLinks, norm, type Brick, type Link } from "./store.js";

/**
 * Energy: what a message or a thought lights up. It starts at the bricks the text names, plus a small head start for
 * warm bricks, then spreads along links: stronger links pass on more, every step loses some, a little randomness keeps
 * it from always walking the same routes, and it stops where it gets too faint. It lasts one thought; warmth is what stays.
 *
 * 5 Nov, after the first real web (214 bricks): energy is shared out among a brick's neighbours (divided by the square
 * root of its number of links), so a hub doesn't light everything around it, and "same source" links carry none, so
 * naming a file doesn't light every brick in it. File bricks and the self brick are not lit by name.
 */

export const SPREAD = { steps: 3, keep: 0.55, threshold: 0.08, noise: 0.15, warmHeadStart: 0.35, focus: 8, focusMin: 0.15 };

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "what", "about", "into", "your", "first", "second", "third", "learning", "project", "meeting", "approach", "tomorrow", "today", "notes", "opening", "question", "there", "their", "where", "which", "would", "could", "should", "think", "thing", "things"]);

/** Bricks the text itself names: the whole name, or a distinctive word of it (a surname, a place). */
export function seedsFor(text: string, bricks: Brick[]): Map<string, number> {
  const t = ` ${norm(text)} `;
  const seeds = new Map<string, number>();
  for (const b of bricks) {
    // A file is named by its file name, and "me" is in half his sentences: neither says what the thought is about.
    if (b.kind === "source" || b.kind === "self") continue;
    const n = norm(b.name);
    if (!n || n.length < 3) continue;
    if (t.includes(` ${n} `)) { seeds.set(b.id, 1); continue; }
    const words = n.split(" ").filter((w) => w.length >= 5 && !STOP.has(w));
    if (words.some((w) => t.includes(` ${w} `))) seeds.set(b.id, Math.max(seeds.get(b.id) ?? 0, 0.6));
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
    if (l.type === "source") continue;
    (neighbours.get(l.a) ?? neighbours.set(l.a, []).get(l.a)!).push({ other: l.b, strength: l.strength });
    (neighbours.get(l.b) ?? neighbours.set(l.b, []).get(l.b)!).push({ other: l.a, strength: l.strength });
  }
  let frontier = [...energy.keys()];
  for (let step = 0; step < SPREAD.steps && frontier.length; step += 1) {
    const next: string[] = [];
    for (const from of frontier) {
      const e = energy.get(from) ?? 0;
      const out = neighbours.get(from) ?? [];
      const share = 1 / Math.sqrt(Math.max(1, out.length / 2));
      for (const { other, strength } of out) {
        const pass = e * SPREAD.keep * share * (strength / (strength + 1.5)) * (1 - SPREAD.noise + rand() * 2 * SPREAD.noise);
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
