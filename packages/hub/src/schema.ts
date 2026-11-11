import { dbVersion, openSqliteDb } from '@dispatch-foo/core';
import type { SqliteDatabase } from '@dispatch-foo/core';

const HUB_DB_VERSION = 1;

// One team's hub. `events` is the ordered log; every other table is the
// state that log adds up to, kept so a read never replays it.
const DDL = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  machine TEXT NOT NULL,
  cid TEXT,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commands (
  cid TEXT PRIMARY KEY,
  ack TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project, id)
);
CREATE TABLE IF NOT EXISTS fields (
  project TEXT NOT NULL,
  task TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  rev INTEGER NOT NULL,
  actor TEXT NOT NULL,
  PRIMARY KEY (project, task, field)
);
CREATE TABLE IF NOT EXISTS entries (
  seq INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  task TEXT NOT NULL,
  kind TEXT NOT NULL,
  entry TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_task ON entries (project, task);
CREATE TABLE IF NOT EXISTS sessions (
  machine TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  project TEXT,
  branch TEXT,
  task TEXT,
  state TEXT NOT NULL,
  waiting_on TEXT,
  label TEXT,
  beat INTEGER NOT NULL,
  stalled_at INTEGER,
  PRIMARY KEY (machine, id)
);
CREATE TABLE IF NOT EXISTS claims (
  project TEXT NOT NULL,
  task TEXT NOT NULL,
  machine TEXT NOT NULL,
  session TEXT NOT NULL,
  actor TEXT NOT NULL,
  writes TEXT NOT NULL,
  since TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (project, task)
);
`;

/**
 * Opens (creating if needed) a team's hub database and applies its schema.
 * A file a newer build wrote is refused, so an older build never reads
 * tables it does not understand as if they were its own.
 */
export function openHubDb(path: string): SqliteDatabase {
  const db = openSqliteDb(path);
  const existing = dbVersion(db);
  if (existing > HUB_DB_VERSION) {
    db.close();
    throw new Error(
      `hub database at ${path} was written by a newer schema (version ${existing}, this build understands ${HUB_DB_VERSION})`
    );
  }
  db.exec(DDL);
  db.exec(`PRAGMA user_version = ${HUB_DB_VERSION}`);
  return db;
}
