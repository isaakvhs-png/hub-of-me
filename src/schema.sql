CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Everything that comes in, stored once. origin: isaak | web | self | session.
-- kind: message | reply | file | edit | instruction | calendar | email | proposal | decline | session-file | run | note
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  file_name TEXT,
  mime TEXT,
  bytes BYTEA,
  size INTEGER NOT NULL DEFAULT 0,
  readable BOOLEAN NOT NULL DEFAULT true,
  placed BOOLEAN NOT NULL DEFAULT false,
  project_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sources_placed ON sources (placed, created_at);

-- A summary. life = the centre ("my life"). kind: summary | project
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'summary',
  is_life BOOLEAN NOT NULL DEFAULT false,
  is_instructions BOOLEAN NOT NULL DEFAULT false,
  project_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  stale BOOLEAN NOT NULL DEFAULT true,
  absorbed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What a summary is made from: other summaries or sources. One input can feed many summaries; one summary many inputs.
CREATE TABLE IF NOT EXISTS feeds (
  summary_id TEXT NOT NULL,
  input_type TEXT NOT NULL,
  input_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (summary_id, input_type, input_id)
);
CREATE INDEX IF NOT EXISTS feeds_input ON feeds (input_type, input_id);

CREATE TABLE IF NOT EXISTS summary_versions (
  id TEXT PRIMARY KEY,
  summary_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  source_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calendar (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  all_day BOOLEAN NOT NULL DEFAULT false,
  note TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL DEFAULT 'isaak',
  source_id TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A project = a workspace session. owner: isaak | it. status: open | closed | junction | waiting | done
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  goal TEXT NOT NULL DEFAULT '',
  proposal_id TEXT,
  summary_id TEXT,
  closed_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  proposed_board TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Board versions. accepted = part of the history (the canon board is the newest accepted one).
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  board_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  log TEXT NOT NULL DEFAULT '[]',
  result TEXT NOT NULL DEFAULT '',
  waiting_piece TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS packs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- kind: project | reply. status: open | accepted | declined | dropped
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'project',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  why TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

-- Things it wants to show him in a popup: a question, a proposal, a shutdown.
CREATE TABLE IF NOT EXISTS popups (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  ref_id TEXT,
  seen BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every model call, for the settings tab and for replay.
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  ms INTEGER NOT NULL,
  chars_in INTEGER NOT NULL,
  chars_out INTEGER NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  what TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Context packs (Isaak, 16 Nov): a short description for him, and what was gathered (summary ids, each with the raw
-- sources under it), so a pack can be read as it was gathered or as it is now.
ALTER TABLE packs ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE packs ADD COLUMN IF NOT EXISTS items TEXT NOT NULL DEFAULT '[]';

-- Merges leave a tag (Isaak, 16 Nov): where a merged or absorbed summary went, and what a merged one came from.
ALTER TABLE summaries ADD COLUMN IF NOT EXISTS went_into TEXT NOT NULL DEFAULT '';
ALTER TABLE summaries ADD COLUMN IF NOT EXISTS merged_from TEXT NOT NULL DEFAULT '';
