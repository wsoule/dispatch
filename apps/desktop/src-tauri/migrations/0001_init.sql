PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,       -- stable hash of the real fs path (from record.cwd)
  name         TEXT NOT NULL,
  path         TEXT UNIQUE NOT NULL,   -- absolute path from cwd, not the dash-encoded dir name
  lang         TEXT,
  stack        TEXT,                   -- JSON array, nullable
  created_at   INTEGER NOT NULL,
  last_active  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                    TEXT PRIMARY KEY,      -- Claude Code sessionId
  project_id            TEXT NOT NULL REFERENCES projects(id),
  agent                 TEXT NOT NULL DEFAULT 'claude',
  model                 TEXT,                  -- last-seen model string, raw
  started_at            INTEGER,               -- min(timestamp) seen
  ended_at              INTEGER,
  last_activity_at      INTEGER NOT NULL,       -- max(timestamp) seen; drives idle detection
  status                TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'ended'
  duration_seconds       INTEGER,
  summary                TEXT,                  -- AI-generated post-hoc, nullable
  prompt_tokens          INTEGER NOT NULL DEFAULT 0,
  completion_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd               REAL NOT NULL DEFAULT 0,
  lines_added            INTEGER NOT NULL DEFAULT 0,
  lines_removed          INTEGER NOT NULL DEFAULT 0,
  tags                   TEXT,                  -- JSON array
  raw_log_path           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files_changed (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  file_path     TEXT NOT NULL,
  change_type   TEXT NOT NULL,   -- 'write' | 'edit' | 'multi_edit' | 'notebook_edit'
  lines_added   INTEGER NOT NULL DEFAULT 0,
  lines_removed INTEGER NOT NULL DEFAULT 0,
  occurred_at   INTEGER NOT NULL
);

-- Internal bookkeeping only, no UI surface. Required for incremental JSONL tailing
-- of a file that Claude Code keeps appending to during a live session.
CREATE TABLE IF NOT EXISTS ingest_state (
  file_path        TEXT PRIMARY KEY,
  byte_offset      INTEGER NOT NULL DEFAULT 0,
  partial_line     TEXT NOT NULL DEFAULT '',
  last_mtime       INTEGER,
  last_ingested_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_files_changed_session ON files_changed(session_id);
