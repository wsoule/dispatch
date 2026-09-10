pub mod queries;

use crate::parser::{dispatch_worktree, session_builder};
use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};
use std::path::Path;
use std::sync::Mutex;

/// Shared, mutex-guarded connection managed as Tauri state. A single process,
/// single connection is enough at this scale — no sidecar, no second writer.
pub struct Db(pub Mutex<Connection>);

/// Renames a database file left by an older version so an upgrading install keeps its
/// ingested history instead of silently opening a fresh, empty database. No-op once
/// `current` exists or `legacy` doesn't.
pub fn adopt_legacy_db(dir: &Path, legacy: &str, current: &str) -> std::io::Result<()> {
    if dir.join(current).exists() || !dir.join(legacy).exists() {
        return Ok(());
    }
    // The `-wal`/`-shm` sidecars move with the main file: the WAL holds committed
    // transactions not yet checkpointed, and SQLite finds both purely by filename.
    for suffix in ["", "-wal", "-shm"] {
        let from = dir.join(format!("{legacy}{suffix}"));
        if from.exists() {
            std::fs::rename(&from, dir.join(format!("{current}{suffix}")))?;
        }
    }
    Ok(())
}

pub fn open(db_path: &Path) -> anyhow::Result<Connection> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;

    let migrations = Migrations::new(vec![
        M::up(include_str!("../../migrations/0001_init.sql")),
        M::up(include_str!("../../migrations/0002_file_diff_content.sql")),
        M::up(include_str!("../../migrations/0003_kanban.sql")),
        M::up(include_str!("../../migrations/0004_session_title.sql")),
        M::up(include_str!("../../migrations/0005_plan.sql")),
        M::up(include_str!("../../migrations/0006_card_pending_launch.sql")),
        M::up(include_str!("../../migrations/0007_drop_unread_tables.sql")),
        M::up(include_str!(
            "../../migrations/0008_reset_cumulative_token_totals.sql"
        )),
    ]);
    migrations.to_latest(&mut conn)?;

    let known_roots = session_builder::known_project_roots(&conn)?;
    reattribute_dispatch_worktree_projects(&conn, &known_roots)?;

    Ok(conn)
}

/// Folds project rows that were created from a Dispatch run worktree cwd (before ingest
/// learned to resolve them) into the project the worktree was checked out from: the
/// canonical row is created or refreshed, the sessions move over, and the run-shaped row is
/// deleted. Rows whose worktree can't be resolved are left alone. Idempotent and a no-op on
/// a database without such rows. Returns how many rows were folded.
pub(crate) fn reattribute_dispatch_worktree_projects(
    conn: &Connection,
    known_roots: &[String],
) -> anyhow::Result<usize> {
    struct Row {
        id: String,
        path: String,
        created_at: i64,
        last_active: i64,
    }
    let mut stmt = conn.prepare("SELECT id, path, created_at, last_active FROM projects")?;
    let rows: Vec<Row> = stmt
        .query_map([], |r| {
            Ok(Row {
                id: r.get(0)?,
                path: r.get(1)?,
                created_at: r.get(2)?,
                last_active: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);

    let mut folded = 0;
    let tx = conn.unchecked_transaction()?;
    for row in rows {
        if !dispatch_worktree::is_dispatch_worktree_path(&row.path) {
            continue;
        }
        let canonical = dispatch_worktree::canonical_project_cwd(&row.path, known_roots);
        let new_id = session_builder::project_id_for_path(&canonical);
        if canonical == row.path || new_id == row.id {
            continue;
        }
        tx.execute(
            "INSERT INTO projects (id, name, path, created_at, last_active)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
                created_at = MIN(created_at, excluded.created_at),
                last_active = MAX(last_active, excluded.last_active)",
            rusqlite::params![
                new_id,
                session_builder::project_name_for_path(&canonical),
                canonical,
                row.created_at,
                row.last_active
            ],
        )?;
        // `sessions` is the only table still referencing projects (0007 dropped the kanban
        // boards); add any future project_id column here.
        tx.execute(
            "UPDATE sessions SET project_id = ?1 WHERE project_id = ?2",
            rusqlite::params![new_id, row.id],
        )?;
        tx.execute("DELETE FROM projects WHERE id = ?1", [&row.id])?;
        folded += 1;
    }
    tx.commit()?;
    Ok(folded)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh scratch directory per call. The counter — not a timestamp — is what makes it
    /// unique: the clock is coarser than nanoseconds here, so parallel tests can read the
    /// same instant and then delete each other's directory on cleanup.
    fn temp_dir() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "dispatch-db-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn adopts_a_legacy_db_with_its_wal_sidecars() {
        let dir = temp_dir();
        for suffix in ["", "-wal", "-shm"] {
            std::fs::write(dir.join(format!("relay.db{suffix}")), suffix).unwrap();
        }

        adopt_legacy_db(&dir, "relay.db", "dispatch.db").unwrap();

        for suffix in ["", "-wal", "-shm"] {
            assert!(!dir.join(format!("relay.db{suffix}")).exists());
            let moved = dir.join(format!("dispatch.db{suffix}"));
            assert_eq!(std::fs::read_to_string(&moved).unwrap(), suffix);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn adopting_leaves_an_existing_current_db_untouched() {
        let dir = temp_dir();
        std::fs::write(dir.join("relay.db"), "stale").unwrap();
        std::fs::write(dir.join("dispatch.db"), "live").unwrap();

        adopt_legacy_db(&dir, "relay.db", "dispatch.db").unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.join("dispatch.db")).unwrap(),
            "live"
        );
        assert!(dir.join("relay.db").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn adopting_is_a_no_op_on_a_fresh_install() {
        let dir = temp_dir();

        adopt_legacy_db(&dir, "relay.db", "dispatch.db").unwrap();

        assert!(!dir.join("dispatch.db").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn insert_project(
        conn: &Connection,
        id: &str,
        path: &str,
        created_at: i64,
        last_active: i64,
    ) {
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, last_active) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                id,
                session_builder::project_name_for_path(path),
                path,
                created_at,
                last_active
            ],
        )
        .unwrap();
    }

    fn insert_session(conn: &Connection, id: &str, project_id: &str) {
        conn.execute(
            "INSERT INTO sessions (id, project_id, last_activity_at, raw_log_path) \
             VALUES (?1, ?2, 1000, '/tmp/log.jsonl')",
            rusqlite::params![id, project_id],
        )
        .unwrap();
    }

    fn project_ids_and_paths(conn: &Connection) -> Vec<(String, String)> {
        let mut stmt = conn
            .prepare("SELECT id, path FROM projects ORDER BY path")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn reattributing_folds_worktree_projects_into_their_repo_root() {
        let dir = temp_dir();
        let conn = open(&dir.join("dispatch.db")).unwrap();

        let root = "/Users/someone/Sites/dispatch".to_string();
        let key = crate::sidecar::daemon_file_key(&root);
        let worktree_a = format!("/Users/someone/.dispatch/worktrees/{key}/r-aaaaaa");
        let worktree_b = format!("/Users/someone/.dispatch/worktrees/{key}/r-bbbbbb");
        let unknown = "/Users/someone/.dispatch/worktrees/0123456789ab/r-cccccc";
        // The canonical row already exists for one worktree (later last_active) and is
        // missing for the other; the third worktree's key matches no known root.
        let root_id = session_builder::project_id_for_path(&root);
        insert_project(&conn, &root_id, &root, 500, 900);
        insert_project(&conn, "old-a", &worktree_a, 600, 2000);
        insert_project(&conn, "old-b", &worktree_b, 700, 800);
        insert_project(&conn, "old-c", unknown, 700, 800);
        insert_session(&conn, "s-a", "old-a");
        insert_session(&conn, "s-b", "old-b");
        insert_session(&conn, "s-c", "old-c");
        insert_project(&conn, "plain", "/tmp/plain", 1, 1);

        let folded = reattribute_dispatch_worktree_projects(&conn, &[root.clone()]).unwrap();
        assert_eq!(folded, 2);

        assert_eq!(
            project_ids_and_paths(&conn),
            vec![
                ("old-c".to_string(), unknown.to_string()),
                (root_id.clone(), root.clone()),
                ("plain".to_string(), "/tmp/plain".to_string()),
            ]
        );
        let (created_at, last_active): (i64, i64) = conn
            .query_row(
                "SELECT created_at, last_active FROM projects WHERE id = ?1",
                [&root_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((created_at, last_active), (500, 2000));

        let session_project = |sid: &str| -> String {
            conn.query_row(
                "SELECT project_id FROM sessions WHERE id = ?1",
                [sid],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(session_project("s-a"), root_id);
        assert_eq!(session_project("s-b"), root_id);
        assert_eq!(session_project("s-c"), "old-c");

        // Second run: nothing left to fold.
        let before = project_ids_and_paths(&conn);
        let folded = reattribute_dispatch_worktree_projects(&conn, &[root]).unwrap();
        assert_eq!(folded, 0);
        assert_eq!(project_ids_and_paths(&conn), before);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reattributing_is_a_no_op_on_a_clean_db() {
        let dir = temp_dir();
        let conn = open(&dir.join("dispatch.db")).unwrap();
        insert_project(&conn, "plain", "/tmp/plain", 1, 1);

        let folded =
            reattribute_dispatch_worktree_projects(&conn, &["/tmp/plain".to_string()]).unwrap();
        assert_eq!(folded, 0);
        assert_eq!(
            project_ids_and_paths(&conn),
            vec![("plain".to_string(), "/tmp/plain".to_string())]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_adopted_db_opens_and_keeps_its_rows() {
        let dir = temp_dir();
        let legacy = dir.join("relay.db");
        {
            let conn = open(&legacy).unwrap();
            conn.execute(
                "INSERT INTO projects (id, name, path, created_at, last_active) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params!["p1", "proj", "/tmp/proj", 1000, 1000],
            )
            .unwrap();
        }

        adopt_legacy_db(&dir, "relay.db", "dispatch.db").unwrap();
        let conn = open(&dir.join("dispatch.db")).unwrap();

        let name: String = conn
            .query_row("SELECT name FROM projects WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "proj");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
