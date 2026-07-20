pub mod queries;

use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};
use std::path::Path;
use std::sync::Mutex;

/// Shared, mutex-guarded connection managed as Tauri state. A single process,
/// single connection is enough at this scale — no sidecar, no second writer.
pub struct Db(pub Mutex<Connection>);

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
