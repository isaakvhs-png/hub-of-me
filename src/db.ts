import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createDb(options?: { databaseUrl?: string; dataDir?: string; memory?: boolean }): Promise<Db> {
  const databaseUrl = options?.databaseUrl ?? (options?.memory || options?.dataDir ? undefined : process.env.DATABASE_URL);
  if (databaseUrl) return pgDb(databaseUrl);
  if (options?.memory) return pgliteDb();
  const dataDir = options?.dataDir ?? process.env.PGLITE_DIR ?? "./data/pglite";
  mkdirSync(dataDir, { recursive: true });
  return pgliteDb(dataDir);
}

async function pgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const client = new PGlite(dataDir);
  const db: Db = {
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
      const result = await client.query(text, params);
      return { rows: result.rows as T[] };
    },
    async exec(text) {
      await client.exec(text);
    },
    async transaction(fn) {
      await client.exec("BEGIN");
      try {
        const result = await fn(db);
        await client.exec("COMMIT");
        return result;
      } catch (error) {
        await client.exec("ROLLBACK");
        throw error;
      }
    },
    async close() {
      await client.close();
    },
  };
  return db;
}

async function pgDb(databaseUrl: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool: Pool = new pg.Pool({ connectionString: databaseUrl });
  const wrap = (runner: { query: Pool["query"] }): Db => ({
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
      const result = await runner.query(text, params);
      return { rows: result.rows as T[] };
    },
    async exec(text) {
      await runner.query(text);
    },
    transaction(fn) {
      return withPgTransaction(pool, fn);
    },
    async close() {
      await pool.end();
    },
  });
  return wrap(pool);
}

async function withPgTransaction<T>(pool: Pool, fn: (tx: Db) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  const tx: Db = {
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
      const result = await client.query(text, params);
      return { rows: result.rows as T[] };
    },
    async exec(text) {
      await client.query(text);
    },
    async transaction() {
      throw new Error("nested transaction");
    },
    async close() {},
  };
  try {
    await client.query("BEGIN");
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function migrate(db: Db): Promise<void> {
  const sql = readFileSync(schemaPath, "utf8");
  const statements = sql
    .split(/;\s*(?:\n|$)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  for (const statement of statements) {
    await db.query(statement);
  }
  const extras = [
    `ALTER TABLE notes ADD COLUMN IF NOT EXISTS mock_era BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE debates ADD COLUMN IF NOT EXISTS mock_era BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE usage_records ALTER COLUMN cost_usd_cents TYPE DOUBLE PRECISION`,
    `ALTER TABLE usage_records ALTER COLUMN cost_eur_cents TYPE DOUBLE PRECISION`,
    `UPDATE debates SET mock_era = true WHERE mock_era = false AND (judge_model LIKE 'mock%' OR id IN (SELECT debate_id FROM debate_sides WHERE provider = 'mock' OR model LIKE 'mock%'))`,
    `UPDATE notes SET mock_era = true WHERE mock_era = false AND EXISTS (SELECT 1 FROM usage_records u WHERE u.user_id = notes.user_id AND u.provider = 'mock') AND (NOT EXISTS (SELECT 1 FROM usage_records u WHERE u.user_id = notes.user_id AND u.provider <> 'mock') OR notes.created_at < (SELECT MIN(u.created_at) FROM usage_records u WHERE u.user_id = notes.user_id AND u.provider <> 'mock'))`,
    `ALTER TABLE debates ADD COLUMN IF NOT EXISTS triggered_by_debate_id TEXT`,
    `ALTER TABLE debates ADD COLUMN IF NOT EXISTS triggered_by_feedback_id TEXT`,
    `CREATE TABLE IF NOT EXISTS debate_feedback (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      debate_id TEXT NOT NULL REFERENCES debates(id),
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      led_to_debate_id TEXT,
      soul_version INTEGER,
      soul_reason TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `ALTER TABLE info_requests ADD COLUMN IF NOT EXISTS subject TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE info_requests ADD COLUMN IF NOT EXISTS context TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE info_requests ADD COLUMN IF NOT EXISTS debate_id TEXT`,
    `CREATE TABLE IF NOT EXISTS evidence_quotes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      debate_id TEXT,
      quote TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS debate_lessons (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      debate_id TEXT NOT NULL,
      text TEXT NOT NULL,
      destination TEXT NOT NULL,
      soul_version INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS carried_forward (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      debate_id TEXT,
      lesson_id TEXT,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `ALTER TABLE info_requests ADD COLUMN IF NOT EXISTS rank INTEGER`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,
    `ALTER TABLE debates ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,
    `ALTER TABLE claims ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,
    `ALTER TABLE mind_notes ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,
    `ALTER TABLE soul_versions ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,
    `ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS why_now TEXT`,
    `ALTER TABLE inner_state ADD COLUMN IF NOT EXISTS next_wake_at TIMESTAMPTZ`,
    `ALTER TABLE inner_state ADD COLUMN IF NOT EXISTS wake_why TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE inner_state ADD COLUMN IF NOT EXISTS start_model TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE inner_state ADD COLUMN IF NOT EXISTS open_notes TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE inner_state ADD COLUMN IF NOT EXISTS life_map TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE inner_state ADD COLUMN IF NOT EXISTS portrait TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE inner_state ADD COLUMN IF NOT EXISTS intentions TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE inner_state ADD COLUMN IF NOT EXISTS self_looked_at TIMESTAMPTZ`,
    `ALTER TABLE inner_state ADD COLUMN IF NOT EXISTS self_portrait TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN IF NOT EXISTS pinned_model TEXT NOT NULL DEFAULT ''`,
    `CREATE TABLE IF NOT EXISTS inner_versions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      why TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `ALTER TABLE notes ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS surfaced BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS fade_reason TEXT`,
    `INSERT INTO debate_feedback (id, user_id, debate_id, body, status, created_at)
     SELECT d.id || '-legacy-feedback', d.user_id, d.id, d.user_feedback, 'done', d.created_at
     FROM debates d
     WHERE d.user_feedback IS NOT NULL AND d.user_feedback <> ''
       AND NOT EXISTS (SELECT 1 FROM debate_feedback f WHERE f.debate_id = d.id)`,
  ];
  for (const statement of extras) {
    await db.query(statement);
  }
}
