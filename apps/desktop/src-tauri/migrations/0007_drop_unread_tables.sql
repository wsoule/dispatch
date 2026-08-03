-- Drops four tables nothing ever read.
--
-- boards/columns/cards backed an in-app kanban that the git-native task board replaced during
-- the Dispatch-first pivot: the ingest pipeline kept creating a board and a card per session,
-- and moving cards on session end, but no Tauri command ever exposed them and no view ever
-- rendered them. Migration 0006's adoption handshake referenced a `launch_or_attach_session`
-- command that no longer exists.
--
-- auth_state cached a subscription tier for free-tier limits and was never read or written
-- after the sign-in flow it belonged to was removed.
DROP INDEX IF EXISTS idx_cards_column;
DROP INDEX IF EXISTS idx_cards_board;
DROP INDEX IF EXISTS idx_columns_board;
DROP TABLE IF EXISTS cards;
DROP TABLE IF EXISTS columns;
DROP TABLE IF EXISTS boards;
DROP TABLE IF EXISTS auth_state;
