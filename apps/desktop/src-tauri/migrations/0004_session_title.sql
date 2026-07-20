-- Claude Code writes its own auto-generated session title into the raw log as an
-- "ai-title" record (the same text shown as "Session name" in `claude` CLI's /status and
-- the --resume picker). Nullable: only populated once Claude has generated a title for a
-- given session (typically within the first couple of turns), and old sessions ingested
-- before this column existed have no such row.
ALTER TABLE sessions ADD COLUMN title TEXT;
