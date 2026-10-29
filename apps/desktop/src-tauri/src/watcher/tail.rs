use crate::db::queries;
use crate::parser::{FileContext, ParsedRecord};
use rusqlite::{Connection, OptionalExtension};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// Caps bytes read and parsed per commit, including segments containing no complete line.
pub const SEGMENT_BYTES: u64 = 256 * 1024;
pub type ParseLine = fn(&str, &mut FileContext) -> Option<ParsedRecord>;

pub struct Cursor {
    pub offset: u64,
    pub partial: Vec<u8>,
    pub context: FileContext,
    needs_context: bool,
}

pub struct Segment {
    pub cursor: Cursor,
    pub lines: Vec<String>,
    pub mtime: i64,
}

/// Loads the durable cursor. Reader recovers legacy header context outside the DB mutex;
/// no additive record effects are replayed during that recovery.
pub fn cursor(conn: &Connection, path: &Path) -> anyhow::Result<Cursor> {
    let key = path.to_string_lossy();
    let state = queries::get_ingest_state(conn, &key)?;
    let saved: Option<(Option<String>, Option<Vec<u8>>)> = conn
        .query_row(
            "SELECT parser_context, partial_bytes FROM ingest_state WHERE file_path = ?1",
            [key.as_ref()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (context, partial) = saved.unwrap_or_default();
    let partial = partial.unwrap_or_else(|| state.partial_line.into_bytes());
    let needs_context = context.is_none();
    let context = match context {
        Some(json) => serde_json::from_str(&json)?,
        None => FileContext::default(),
    };
    Ok(Cursor {
        offset: state.byte_offset.max(0) as u64,
        partial,
        context,
        needs_context,
    })
}

/// Persists a recovered legacy context without advancing its already committed offset.
pub fn persist_context(conn: &Connection, path: &Path, cursor: &Cursor) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE ingest_state SET parser_context = ?2, partial_bytes = ?3 WHERE file_path = ?1",
        rusqlite::params![
            path.to_string_lossy(),
            serde_json::to_string(&cursor.context)?,
            cursor.partial
        ],
    )?;
    Ok(())
}

/// A single open file and catch-up boundary keep replacement/appends from mixing file
/// generations between commits. Later appends are handled by queued watcher events.
pub struct Reader {
    file: File,
    end_offset: u64,
}
impl Reader {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let file = File::open(path)?;
        let end_offset = file.metadata()?.len();
        Ok(Self { file, end_offset })
    }
    /// Reads the legacy committed prefix outside the DB mutex; never reapplies record effects.
    pub fn recover_context(
        &mut self,
        cursor: &mut Cursor,
        parse: ParseLine,
    ) -> anyhow::Result<bool> {
        let recovered = cursor.needs_context && cursor.offset > 0;
        if self.end_offset < cursor.offset {
            cursor.offset = 0;
            cursor.partial.clear();
            cursor.context = FileContext::default();
            cursor.needs_context = false;
            return Ok(false);
        }
        if cursor.needs_context && cursor.offset > 0 {
            self.file.seek(SeekFrom::Start(0))?;
            let prefix = Read::by_ref(&mut self.file).take(cursor.offset);
            let mut reader = BufReader::new(prefix);
            let mut bytes = Vec::new();
            cursor.partial.clear();
            while reader.read_until(b'\n', &mut bytes)? > 0 {
                if bytes.last() == Some(&b'\n') {
                    parse(&String::from_utf8_lossy(&bytes), &mut cursor.context);
                } else {
                    cursor.partial = bytes.clone();
                }
                bytes.clear();
            }
        }
        cursor.needs_context = false;
        Ok(recovered)
    }

    /// Reads outside the DB mutex. Only the caller owning this file may advance its cursor.
    pub fn read_segment(&mut self, cursor: Cursor) -> anyhow::Result<Option<Segment>> {
        let file = &mut self.file;
        file.seek(SeekFrom::Start(cursor.offset))?;
        let mut bytes = Vec::new();
        Read::by_ref(file)
            .take(SEGMENT_BYTES.min(self.end_offset.saturating_sub(cursor.offset)))
            .read_to_end(&mut bytes)?;
        if bytes.is_empty() {
            return Ok(None);
        }
        let offset = cursor.offset + bytes.len() as u64;
        let mut combined = cursor.partial;
        combined.extend(bytes);
        let end = combined
            .iter()
            .rposition(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        let lines = combined[..end]
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| String::from_utf8_lossy(line).into_owned())
            .collect();
        let partial = combined[end..].to_vec();
        let mtime = file
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        Ok(Some(Segment {
            cursor: Cursor {
                offset,
                partial,
                context: cursor.context,
                needs_context: false,
            },
            lines,
            mtime,
        }))
    }
}

#[cfg(test)]
pub fn read_segment(path: &Path, cursor: Cursor) -> anyhow::Result<Option<Segment>> {
    Reader::open(path)?.read_segment(cursor)
}

/// All record effects and continuation fields share the caller's SQLite transaction.
pub fn checkpoint(conn: &Connection, path: &Path, segment: &Segment) -> anyhow::Result<()> {
    let key = path.to_string_lossy();
    queries::set_ingest_state(
        conn,
        &key,
        segment.cursor.offset as i64,
        &String::from_utf8_lossy(&segment.cursor.partial),
        segment.mtime,
    )?;
    conn.execute(
        "UPDATE ingest_state SET parser_context = ?2, partial_bytes = ?3 WHERE file_path = ?1",
        rusqlite::params![
            key,
            serde_json::to_string(&segment.cursor.context)?,
            segment.cursor.partial
        ],
    )?;
    Ok(())
}
