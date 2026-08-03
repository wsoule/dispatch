pub mod queries;

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
    ]);
    migrations.to_latest(&mut conn)?;

    Ok(conn)
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
