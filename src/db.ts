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
}
