-- Kanban task board: one board per project (auto-created, never user-managed), customizable
-- columns per board, cards that are either linked to a session or created manually for
-- pre-session planning. See queries::ensure_board_for_project for the seeding logic that
-- gives every new board its four role-tagged columns.
CREATE TABLE IF NOT EXISTS boards (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL UNIQUE REFERENCES projects(id),
  created_at  INTEGER NOT NULL
);

-- `role` drives auto-sync: when a linked session's status transitions, its card is moved to
-- the column on its board whose role matches ('in_progress' on session start, 'review' on
-- session end). Only the four seeded columns ever carry a role; user-added columns are
-- always NULL-role and require a manual drag. Roles are fixed at creation time — not
-- reassignable in v1 — so auto-sync never has to resolve ambiguity between two same-role
-- columns on one board.
CREATE TABLE IF NOT EXISTS columns (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES boards(id),
  name        TEXT NOT NULL,
  role        TEXT,              -- 'todo' | 'in_progress' | 'review' | 'done' | NULL
  position    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id            TEXT PRIMARY KEY,
  board_id      TEXT NOT NULL REFERENCES boards(id),
  column_id     TEXT NOT NULL REFERENCES columns(id),
  session_id    TEXT UNIQUE REFERENCES sessions(id),  -- nullable; UNIQUE so a session never backs two cards
  title         TEXT NOT NULL,
  description   TEXT,
  position      INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_columns_board ON columns(board_id);
CREATE INDEX IF NOT EXISTS idx_cards_board ON cards(board_id);
CREATE INDEX IF NOT EXISTS idx_cards_column ON cards(column_id);
