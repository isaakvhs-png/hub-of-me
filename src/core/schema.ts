import type { Db } from "../db.js";

/**
 * The rebuild's data model (BUILD_SPEC.md §4). Inline, idempotent: CREATE TABLE IF NOT EXISTS and ADD COLUMN IF NOT EXISTS.
 * Every table has user_id, created_at and archived_at. Nothing is deleted.
 * JSON is stored as TEXT (the same on Postgres and PGlite).
 *
 * Two tables existed before the rebuild and are extended in place: `sources` and `bricks`. Their old rows are archived by
 * the fresh start (src/core/fresh.ts), so only rows written by the rebuild are live.
 */
const BASE = `user_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), archived_at TIMESTAMPTZ`;

export const CORE_SCHEMA: string[] = [
  // Ring 0: everything kept whole (append-only)
  `CREATE TABLE IF NOT EXISTS stream (
    id TEXT PRIMARY KEY, ${BASE}, kind TEXT NOT NULL, content TEXT NOT NULL, sent_with_source TEXT,
    client_msg_id TEXT, run_id TEXT, filed_at TIMESTAMPTZ, at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS stream_user_at ON stream (user_id, at)`,
  // sources existed (title, url, excerpt, kind, raw_text, origin); the rebuild adds what §4 needs.
  `ALTER TABLE sources ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE sources ADD COLUMN IF NOT EXISTS orig_size INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE sources ADD COLUMN IF NOT EXISTS stored_size INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE sources ADD COLUMN IF NOT EXISTS filed BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE sources ADD COLUMN IF NOT EXISTS failed_parts TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE sources ADD COLUMN IF NOT EXISTS stream_id TEXT`,
  `ALTER TABLE sources ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,
  `ALTER TABLE sources ADD COLUMN IF NOT EXISTS at TIMESTAMPTZ NOT NULL DEFAULT now()`,

  // Ring 1: bricks (existed; the rebuild adds corner and last_used_at)
  `ALTER TABLE bricks ADD COLUMN IF NOT EXISTS corner TEXT NOT NULL DEFAULT 'his'`,
  `ALTER TABLE bricks ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY, ${BASE}, brick_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'his', status TEXT NOT NULL DEFAULT 'open', superseded_by TEXT,
    quote TEXT NOT NULL DEFAULT '', source_id TEXT, char_start INTEGER, char_end INTEGER, due_at TIMESTAMPTZ, run_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS entries_brick ON entries (brick_id)`,
  `CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY, ${BASE}, a TEXT NOT NULL, b TEXT NOT NULL, relation TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
    strength DOUBLE PRECISION NOT NULL DEFAULT 1, made_by TEXT NOT NULL DEFAULT 'filing', run_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY, ${BASE}, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, model TEXT NOT NULL,
    vector TEXT NOT NULL, text_hash TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS embeddings_owner ON embeddings (owner_kind, owner_id)`,

  // Rings 2..n and the centre
  `CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY, ${BASE}, kind TEXT NOT NULL DEFAULT 'page', title TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'fresh', version INTEGER NOT NULL DEFAULT 1,
    origin TEXT NOT NULL DEFAULT 'own', reviewed_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS page_members (
    id TEXT PRIMARY KEY, ${BASE}, page_id TEXT NOT NULL, member_kind TEXT NOT NULL, member_id TEXT NOT NULL,
    weight DOUBLE PRECISION NOT NULL DEFAULT 1, added_by TEXT NOT NULL DEFAULT 'code'
  )`,
  `CREATE TABLE IF NOT EXISTS page_versions (
    id TEXT PRIMARY KEY, ${BASE}, page_id TEXT NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    change_note TEXT NOT NULL DEFAULT '', claim_changed BOOLEAN NOT NULL DEFAULT false, reason_chain TEXT NOT NULL DEFAULT '[]',
    run_id TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS stale_marks (
    id TEXT PRIMARY KEY, ${BASE}, page_id TEXT NOT NULL, route TEXT NOT NULL, reason TEXT NOT NULL, root_id TEXT NOT NULL DEFAULT '',
    triage TEXT, triage_why TEXT NOT NULL DEFAULT '', done_at TIMESTAMPTZ, run_id TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS revisions (
    id TEXT PRIMARY KEY, ${BASE}, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, his_text TEXT NOT NULL,
    its_reply TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', pushed_back BOOLEAN NOT NULL DEFAULT false, applied_version INTEGER
  )`,

  // Work
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, ${BASE}, trigger TEXT NOT NULL, job TEXT NOT NULL DEFAULT 'reply', purpose TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 0, due_at TIMESTAMPTZ, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'queued', left_off TEXT NOT NULL DEFAULT '', parent_goal_id TEXT, input TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '', why TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS runs_user_status ON runs (user_id, status)`,
  `CREATE TABLE IF NOT EXISTS run_steps (
    id TEXT PRIMARY KEY, ${BASE}, run_id TEXT NOT NULL, node TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
    model TEXT, ms INTEGER NOT NULL DEFAULT 0, chars_in INTEGER NOT NULL DEFAULT 0, chars_out INTEGER NOT NULL DEFAULT 0,
    ok BOOLEAN NOT NULL DEFAULT true, detail TEXT NOT NULL DEFAULT '{}', seq INTEGER NOT NULL DEFAULT 0, at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS run_steps_run ON run_steps (run_id, seq)`,
  `CREATE TABLE IF NOT EXISTS packs (
    id TEXT PRIMARY KEY, ${BASE}, run_id TEXT NOT NULL, contents TEXT NOT NULL DEFAULT '[]', used TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY, ${BASE}, text TEXT NOT NULL, why TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT 'self',
    status TEXT NOT NULL DEFAULT 'open', next_run_id TEXT, steps TEXT NOT NULL DEFAULT '[]', origin TEXT NOT NULL DEFAULT 'own'
  )`,
  `CREATE TABLE IF NOT EXISTS bench (
    id TEXT PRIMARY KEY, ${BASE}, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open', refs TEXT NOT NULL DEFAULT '{}', target TEXT NOT NULL DEFAULT 'self', run_id TEXT,
    his_note TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'its'
  )`,
  `CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY, ${BASE}, target TEXT NOT NULL DEFAULT 'self', title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'hand',
    problem TEXT NOT NULL DEFAULT '', proposal TEXT NOT NULL DEFAULT '', spec TEXT NOT NULL DEFAULT '{}', prediction TEXT NOT NULL DEFAULT '',
    depends_on TEXT NOT NULL DEFAULT '[]', unblocks TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open',
    evidence_runs TEXT NOT NULL DEFAULT '[]', evidence_count INTEGER NOT NULL DEFAULT 0, protected BOOLEAN NOT NULL DEFAULT false,
    his_decision TEXT, his_why TEXT NOT NULL DEFAULT '', built_in TEXT, live_at TIMESTAMPTZ, proof_run TEXT, merged_into TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY, ${BASE}, target TEXT NOT NULL DEFAULT 'self', title TEXT NOT NULL, why TEXT NOT NULL DEFAULT '',
    request_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'ready', his_decision TEXT, his_why TEXT NOT NULL DEFAULT '',
    spec TEXT NOT NULL DEFAULT '', prediction TEXT NOT NULL DEFAULT '', cost TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY, ${BASE}, scale TEXT NOT NULL, period TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', signals TEXT NOT NULL DEFAULT '{}', run_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS review_actions (
    id TEXT PRIMARY KEY, ${BASE}, report_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
    applied BOOLEAN NOT NULL DEFAULT false, result TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS attention (
    id TEXT PRIMARY KEY, ${BASE}, what TEXT NOT NULL, ms INTEGER NOT NULL DEFAULT 0, at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS heartbeat (
    id TEXT PRIMARY KEY, ${BASE}, at TIMESTAMPTZ NOT NULL DEFAULT now(), commit_sha TEXT NOT NULL DEFAULT ''
  )`,
  // Small key/value memory for code (fresh-start marker, last spot-check day, …). Not part of the entity's memory.
  `CREATE TABLE IF NOT EXISTS core_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now())`,
];

export async function migrateCore(db: Db): Promise<void> {
  for (const statement of CORE_SCHEMA) await db.query(statement);
}
