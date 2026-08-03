-- Repairs sessions whose token counters were accumulated from a cumulative source.
--
-- Codex reports `total_token_usage` — the session's running total — on every `token_count`
-- event, but upsert_session added each one as though it were that record's own increment. A
-- session with N such events therefore stored the sum of N running totals, inflating its
-- counters (and the cost derived from them) roughly quadratically in its turn count.
--
-- upsert_session now folds cumulative sources with MAX, which is idempotent, so the repair is
-- simply to clear the bad numbers and let the watcher re-tail the logs: zeroing the counters
-- and dropping the ingest_state rows makes the next backfill re-read each file from offset 0
-- and recompute. The session rows themselves are kept so AI-generated summaries, titles, and
-- tags survive. Their files_changed rows are deleted first, since those are append-only and
-- would otherwise be duplicated by the re-read.
DELETE FROM files_changed
WHERE session_id IN (SELECT id FROM sessions WHERE agent = 'codex');

DELETE FROM ingest_state
WHERE file_path IN (SELECT raw_log_path FROM sessions WHERE agent = 'codex');

UPDATE sessions
SET prompt_tokens = 0,
    completion_tokens = 0,
    cache_read_tokens = 0,
    cache_creation_tokens = 0,
    cost_usd = 0,
    lines_added = 0,
    lines_removed = 0
WHERE agent = 'codex';
