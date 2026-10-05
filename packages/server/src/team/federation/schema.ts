// The federation's tables in the board-sync ledger's state.db. The ledger's
// own tables keep their meaning, so an older build never meets a v2 op there.
export const FED_SCHEMA = `
CREATE TABLE IF NOT EXISTS fed_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fed_outbox (seq INTEGER PRIMARY KEY, op_json TEXT NOT NULL);
-- This replica's own log, kept after publishing, so a merge that removes its
-- segments from the branch loses nothing (FW-R22 M6).
CREATE TABLE IF NOT EXISTS fed_log (seq INTEGER PRIMARY KEY, op_json TEXT NOT NULL);
-- The hash of every op this machine applied, per replica and seq: a cut or a
-- rival is checked against it once the cursor has moved on (FW-R23).
CREATE TABLE IF NOT EXISTS fed_seen_ops (replica TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (replica, seq));
-- The key each replica speaks with, as the roster decides it (FW-R24): the
-- founder's from the trusted found, others' from an accepted admit or recover.
CREATE TABLE IF NOT EXISTS fed_keys (
  replica TEXT PRIMARY KEY, handle TEXT NOT NULL, device TEXT NOT NULL, build TEXT NOT NULL,
  sign_pub TEXT NOT NULL, seal_pub TEXT NOT NULL, fingerprint TEXT NOT NULL, key_seq INTEGER NOT NULL,
  legacy_through INTEGER, legacy_digest TEXT, invite_json TEXT, first_seen_at TEXT NOT NULL
);
-- Every self-signed key op seen per replica id, a few per id: rival claims
-- until the roster decides one (FW-R24).
CREATE TABLE IF NOT EXISTS fed_key_claims (
  replica TEXT NOT NULL, handle TEXT NOT NULL, device TEXT NOT NULL, build TEXT NOT NULL,
  sign_pub TEXT NOT NULL, seal_pub TEXT NOT NULL, fingerprint TEXT NOT NULL, key_seq INTEGER NOT NULL,
  legacy_through INTEGER, legacy_digest TEXT, invite_json TEXT, first_seen_at TEXT NOT NULL,
  PRIMARY KEY (replica, sign_pub)
);
-- The head columns are null for a log halted before its first op verified.
CREATE TABLE IF NOT EXISTS fed_cursors (replica TEXT PRIMARY KEY, seq INTEGER, hash TEXT, hlc TEXT, halted TEXT);
-- Every verified roster op, whatever its action, with the key that signed it:
-- the fold reads only those on each replica's decided key (FW-R24).
CREATE TABLE IF NOT EXISTS fed_roster (replica TEXT NOT NULL, sign_pub TEXT NOT NULL, seq INTEGER NOT NULL, hlc TEXT NOT NULL, hash TEXT NOT NULL, body_json TEXT NOT NULL, PRIMARY KEY (replica, sign_pub, seq));
CREATE TABLE IF NOT EXISTS fed_runs (run TEXT PRIMARY KEY, replica TEXT NOT NULL, task TEXT, run_kind TEXT NOT NULL, live INTEGER NOT NULL, waiting_on TEXT, hlc TEXT NOT NULL);
-- A run two replicas claimed first: bound to neither until all but one claimant is revoked.
CREATE TABLE IF NOT EXISTS fed_run_conflicts (run TEXT PRIMARY KEY, replicas_json TEXT NOT NULL);
-- Claims refused because their run was bound here first, for an admin's resolution.
CREATE TABLE IF NOT EXISTS fed_run_claims (run TEXT PRIMARY KEY, claims_json TEXT NOT NULL);
-- State entries waiting for the next pass, by their recipients ("a,b").
-- Every mail op verified here, so a forward carries only a real one (FW-R32(2)).
-- Never pruned (FW-R36(1)): a forward is judged against these hashes alone.
CREATE TABLE IF NOT EXISTS fed_mail_seen (replica TEXT NOT NULL, seq INTEGER NOT NULL, hash BLOB NOT NULL, PRIMARY KEY (replica, seq));
-- The hash of every verified op of a type a handler may ask to reread, kept
-- forever: a reread stages only a line matching it (FW-R37(2)).
CREATE TABLE IF NOT EXISTS fed_reread_seen (replica TEXT NOT NULL, seq INTEGER NOT NULL, hash BLOB NOT NULL, PRIMARY KEY (replica, seq));
-- Pruned run ids and the replica that ran each: never claimed by another.
CREATE TABLE IF NOT EXISTS fed_run_tombs (run TEXT PRIMARY KEY, replica TEXT NOT NULL);
-- Team memory as the team merged it (F3): each field's last writer by hlc,
-- and per entry the trust this machine derived and whether memory.db lags.
-- backed: a human the publisher speaks for made its latest gated change;
-- waiting: it waits on a gate or a cap here.
CREATE TABLE IF NOT EXISTS fed_memory (memory TEXT PRIMARY KEY, trust TEXT NOT NULL, origin_replica TEXT NOT NULL, dirty INTEGER NOT NULL, backed INTEGER NOT NULL DEFAULT 0, waiting INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS fed_memory_fields (memory TEXT NOT NULL, field TEXT NOT NULL, hlc TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY (memory, field));
-- FW-R39: what each replica speaks, from its key ops (per signing key) and
-- from its latest presence re-announcement.
CREATE TABLE IF NOT EXISTS fed_caps_keys (replica TEXT NOT NULL, sign_pub TEXT NOT NULL, caps_json TEXT NOT NULL, PRIMARY KEY (replica, sign_pub));
CREATE TABLE IF NOT EXISTS fed_caps_presence (replica TEXT PRIMARY KEY, caps_json TEXT NOT NULL, hlc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fed_state_out (id INTEGER PRIMARY KEY, recipients TEXT NOT NULL, entry_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fed_replicas (replica TEXT PRIMARY KEY, build TEXT NOT NULL, device TEXT NOT NULL, last_hlc TEXT NOT NULL, skew_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fed_members (channel TEXT NOT NULL, member TEXT NOT NULL, joined INTEGER NOT NULL, hlc TEXT NOT NULL, PRIMARY KEY (channel, member));
CREATE TABLE IF NOT EXISTS fed_agents (address TEXT PRIMARY KEY, replica TEXT NOT NULL, display_name TEXT NOT NULL, client TEXT NOT NULL, status TEXT NOT NULL, hlc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fed_held_ops (message_id TEXT PRIMARY KEY, op_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fed_inbox (replica TEXT NOT NULL, seq INTEGER NOT NULL, hlc TEXT NOT NULL, payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, first_at TEXT NOT NULL, PRIMARY KEY (replica, seq));
CREATE TABLE IF NOT EXISTS fed_parked (replica TEXT NOT NULL, seq INTEGER NOT NULL, op_json TEXT NOT NULL, reason TEXT NOT NULL, first_at TEXT NOT NULL, PRIMARY KEY (replica, seq));
CREATE TABLE IF NOT EXISTS fed_unknown (replica TEXT NOT NULL, seq INTEGER NOT NULL, op_json TEXT NOT NULL, PRIMARY KEY (replica, seq));
CREATE TABLE IF NOT EXISTS fed_published (kind TEXT NOT NULL, ref TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (kind, ref));
CREATE TABLE IF NOT EXISTS fed_quota (replica TEXT NOT NULL, hour TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (replica, hour));
CREATE TABLE IF NOT EXISTS fed_problems (subject TEXT PRIMARY KEY, message TEXT NOT NULL, at TEXT NOT NULL);
-- Notes a person acknowledged; the same message is not raised again.
CREATE TABLE IF NOT EXISTS fed_problem_acks (subject TEXT NOT NULL, message TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (subject, message));
CREATE TABLE IF NOT EXISTS fed_audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, detail_json TEXT NOT NULL);
-- Which tasks each applied v2 task op touched, kept 30 days, so a revocation
-- that cuts below ops already applied here can list them.
CREATE TABLE IF NOT EXISTS fed_applied (replica TEXT NOT NULL, seq INTEGER NOT NULL, task TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (replica, seq, task));
-- Every v1 op this root put in its outbox, by any build on it (a trigger fires
-- for an older build too), so reissue() signs only what this root minted.
CREATE TABLE IF NOT EXISTS fed_v1_minted (seq INTEGER PRIMARY KEY, op_json TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS fed_v1_minted_keep AFTER INSERT ON outbox BEGIN
  INSERT OR REPLACE INTO fed_v1_minted (seq, op_json) VALUES (NEW.seq, NEW.op);
END;
`;

/** Brings a state.db from before FW-R24 forward: roster rows gain the key
 *  that signed them, and every pinned key becomes a claim. */
export const FED_MIGRATE_KEYS = `
ALTER TABLE fed_roster RENAME TO fed_roster_v0;
CREATE TABLE fed_roster (replica TEXT NOT NULL, sign_pub TEXT NOT NULL, seq INTEGER NOT NULL, hlc TEXT NOT NULL, hash TEXT NOT NULL, body_json TEXT NOT NULL, PRIMARY KEY (replica, sign_pub, seq));
INSERT INTO fed_roster (replica, sign_pub, seq, hlc, hash, body_json)
  SELECT r.replica, COALESCE(k.sign_pub, ''), r.seq, r.hlc, r.hash, r.body_json
  FROM fed_roster_v0 r LEFT JOIN fed_keys k ON k.replica = r.replica;
DROP TABLE fed_roster_v0;
INSERT OR IGNORE INTO fed_key_claims SELECT * FROM fed_keys;
`;

/** Brings fed_mail_seen from hex text with a time to the 32-byte hash alone. */
export const FED_MIGRATE_MAIL_SEEN = `
ALTER TABLE fed_mail_seen RENAME TO fed_mail_seen_v0;
CREATE TABLE fed_mail_seen (replica TEXT NOT NULL, seq INTEGER NOT NULL, hash BLOB NOT NULL, PRIMARY KEY (replica, seq));
`;
