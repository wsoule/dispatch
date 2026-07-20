-- Adoption handshake for terminal-spawned sessions. When a user spawns a Claude Code
-- session from a card (commands::launch_or_attach_session), the session id Claude will
-- generate isn't known yet, so the card can't be linked at launch time. Instead the card
-- is stamped with `pending_launch_at` (unix seconds); the next brand-new session ingested
-- for that project within a short window (queries::adopt_pending_card_for_session) adopts
-- the card instead of the ingest path auto-creating a duplicate. NULL = not awaiting a
-- launch. Cleared on adoption; a stale stamp simply expires (window check) and is ignored.
ALTER TABLE cards ADD COLUMN pending_launch_at INTEGER;
