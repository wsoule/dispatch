-- Caches the signed-in user's subscription plan locally, so the watcher's ingest pipeline
-- (which runs independently of any UI screen) can enforce free-tier limits even offline,
-- using the last plan seen. Single-row table (id is always 1) — there is only ever one
-- signed-in user per local install. Absence of a row (never signed in yet) means free tier.
CREATE TABLE IF NOT EXISTS auth_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  email      TEXT,
  plan       TEXT NOT NULL DEFAULT 'free',
  updated_at INTEGER NOT NULL
);
