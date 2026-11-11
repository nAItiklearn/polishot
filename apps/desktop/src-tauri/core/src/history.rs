//! Capture history in SQLite (bundled, FTS5) at `%LOCALAPPDATA%\<product>\history\history.db`.
//!
//! `captures` holds one row per capture; `captures_fts` is an external-content FTS5 index over
//! `ocr_text`, kept in sync by triggers. OCR text is private: it is stored and searched, never
//! logged.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::store::Source;

/// Documents larger than this are refused (they would only bloat the database).
pub const MAX_DOC_BYTES: usize = 8 * 1024 * 1024;
const MAX_QUERY_TOKENS: usize = 8;
const MAX_TOKEN_CHARS: usize = 64;
const EXCERPT_CHARS: usize = 140;
/// The history list reads only this many characters of each row's OCR text (enough for the
/// excerpt even with plenty of whitespace). The full text can be tens of kilobytes per row, and a
/// page of 500 rows used to drag all of it through the query.
const EXCERPT_SOURCE_CHARS: usize = 600;
const MAX_OCR_CHARS: usize = 200_000;

/// `HistoryItem` from CONTRACTS section 5.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: String,
    pub created_at: u64,
    pub width: u32,
    pub height: u32,
    pub excerpt: String,
    pub has_doc: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub id: String,
    pub created_at: u64,
    pub width: u32,
    pub height: u32,
    pub source: Source,
    pub doc_json: Option<String>,
}

pub struct History {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS captures (
    id         TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL,
    width      INTEGER NOT NULL,
    height     INTEGER NOT NULL,
    source     TEXT NOT NULL DEFAULT 'region',
    ocr_text   TEXT NOT NULL DEFAULT '',
    doc_json   TEXT
);
CREATE INDEX IF NOT EXISTS captures_created_at ON captures (created_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS captures_fts USING fts5(
    ocr_text,
    content = 'captures',
    content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS captures_ai AFTER INSERT ON captures BEGIN
    INSERT INTO captures_fts (rowid, ocr_text) VALUES (new.rowid, new.ocr_text);
END;
CREATE TRIGGER IF NOT EXISTS captures_ad AFTER DELETE ON captures BEGIN
    INSERT INTO captures_fts (captures_fts, rowid, ocr_text) VALUES ('delete', old.rowid, old.ocr_text);
END;
CREATE TRIGGER IF NOT EXISTS captures_au AFTER UPDATE OF ocr_text ON captures BEGIN
    INSERT INTO captures_fts (captures_fts, rowid, ocr_text) VALUES ('delete', old.rowid, old.ocr_text);
    INSERT INTO captures_fts (rowid, ocr_text) VALUES (new.rowid, new.ocr_text);
END;
";

fn db_err(e: rusqlite::Error) -> String {
    format!("History database error: {e}")
}

impl History {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("Could not create the history folder: {e}"))?;
        }
        let conn = Connection::open(path).map_err(db_err)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self, String> {
        Self::init(Connection::open_in_memory().map_err(db_err)?)
    }

    fn init(conn: Connection) -> Result<Self, String> {
        // `journal_mode` returns a row, so it must go through query_row.
        let _: String = conn
            .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
            .unwrap_or_default();
        conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;")
            .map_err(db_err)?;
        conn.execute_batch(SCHEMA).map_err(db_err)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "History database is unavailable.".to_string())
    }

    /// Insert a capture row, or leave an existing one alone.
    pub fn insert_capture(
        &self,
        id: &str,
        created_at: u64,
        width: u32,
        height: u32,
        source: Source,
    ) -> Result<(), String> {
        self.lock()?
            .execute(
                "INSERT OR IGNORE INTO captures (id, created_at, width, height, source) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, created_at as i64, width, height, source.as_str()],
            )
            .map(|_| ())
            .map_err(db_err)
    }

    /// Store recognised text. Returns false when the capture no longer exists.
    pub fn set_ocr_text(&self, id: &str, text: &str) -> Result<bool, String> {
        let clipped: String = text.chars().take(MAX_OCR_CHARS).collect();
        self.lock()?
            .execute(
                "UPDATE captures SET ocr_text = ?2 WHERE id = ?1",
                params![id, clipped],
            )
            .map(|n| n > 0)
            .map_err(db_err)
    }

    /// Attach the editor document. Returns false when the capture does not exist.
    pub fn save_doc(&self, id: &str, doc_json: &str) -> Result<bool, String> {
        if doc_json.len() > MAX_DOC_BYTES {
            return Err("That document is too large to save.".to_string());
        }
        if serde_json::from_str::<serde_json::Value>(doc_json).is_err() {
            return Err("The document is not valid JSON.".to_string());
        }
        self.lock()?
            .execute(
                "UPDATE captures SET doc_json = ?2 WHERE id = ?1",
                params![id, doc_json],
            )
            .map(|n| n > 0)
            .map_err(db_err)
    }

    pub fn get(&self, id: &str) -> Result<Option<Row>, String> {
        self.lock()?
            .query_row(
                "SELECT id, created_at, width, height, source, doc_json FROM captures WHERE id = ?1",
                params![id],
                |r| {
                    Ok(Row {
                        id: r.get(0)?,
                        created_at: r.get::<_, i64>(1)? as u64,
                        width: r.get(2)?,
                        height: r.get(3)?,
                        source: Source::parse(&r.get::<_, String>(4)?),
                        doc_json: r.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(db_err)
    }

    /// Newest first. With a query, matches OCR text by token prefix (all tokens must match).
    pub fn list(
        &self,
        query: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<HistoryItem>, String> {
        let limit = i64::from(limit.clamp(1, 500));
        let offset = i64::from(offset);
        let conn = self.lock()?;
        let match_expr = query.and_then(fts_query);
        let map_row = |r: &rusqlite::Row<'_>| -> rusqlite::Result<HistoryItem> {
            let text: String = r.get(5)?;
            Ok(HistoryItem {
                id: r.get(0)?,
                created_at: r.get::<_, i64>(1)? as u64,
                width: r.get(2)?,
                height: r.get(3)?,
                has_doc: r.get::<_, i64>(4)? != 0,
                excerpt: excerpt(&text),
            })
        };
        let rows = match &match_expr {
            Some(expr) => {
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT c.id, c.created_at, c.width, c.height, c.doc_json IS NOT NULL,
                                substr(c.ocr_text, 1, {EXCERPT_SOURCE_CHARS})
                         FROM captures_fts f JOIN captures c ON c.rowid = f.rowid
                         WHERE captures_fts MATCH ?1
                         ORDER BY c.created_at DESC LIMIT ?2 OFFSET ?3"
                    ))
                    .map_err(db_err)?;
                let it = stmt
                    .query_map(params![expr, limit, offset], map_row)
                    .map_err(db_err)?;
                it.collect::<Result<Vec<_>, _>>().map_err(db_err)?
            }
            None => {
                // A query that reduces to no searchable tokens (e.g. only punctuation) matches nothing.
                if query.is_some_and(|q| !q.trim().is_empty()) {
                    return Ok(Vec::new());
                }
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT id, created_at, width, height, doc_json IS NOT NULL,
                                substr(ocr_text, 1, {EXCERPT_SOURCE_CHARS})
                         FROM captures ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
                    ))
                    .map_err(db_err)?;
                let it = stmt
                    .query_map(params![limit, offset], map_row)
                    .map_err(db_err)?;
                it.collect::<Result<Vec<_>, _>>().map_err(db_err)?
            }
        };
        Ok(rows)
    }

    /// Delete one row. Returns whether it existed.
    pub fn delete(&self, id: &str) -> Result<bool, String> {
        self.lock()?
            .execute("DELETE FROM captures WHERE id = ?1", params![id])
            .map(|n| n > 0)
            .map_err(db_err)
    }

    /// Delete every row and return the ids that were removed.
    pub fn clear(&self) -> Result<Vec<String>, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let ids: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM captures").map_err(db_err)?;
            let it = stmt.query_map([], |r| r.get(0)).map_err(db_err)?;
            it.collect::<Result<_, _>>().map_err(db_err)?
        };
        tx.execute("DELETE FROM captures", []).map_err(db_err)?;
        tx.execute(
            "INSERT INTO captures_fts (captures_fts) VALUES ('rebuild')",
            [],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(ids)
    }

    #[cfg(test)]
    pub fn count(&self) -> Result<u64, String> {
        self.lock()?
            .query_row("SELECT COUNT(*) FROM captures", [], |r| r.get::<_, i64>(0))
            .map(|n| n as u64)
            .map_err(db_err)
    }
}

/// Turn free text into a safe FTS5 expression: each alphanumeric run becomes a quoted prefix
/// term, ANDed together. Quotes and operators can never reach the FTS parser.
pub fn fts_query(raw: &str) -> Option<String> {
    let terms: Vec<String> = raw
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .take(MAX_QUERY_TOKENS)
        .map(|t| {
            let t: String = t.chars().take(MAX_TOKEN_CHARS).collect();
            format!("\"{t}\"*")
        })
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

fn excerpt(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= EXCERPT_CHARS {
        flat
    } else {
        let cut: String = flat.chars().take(EXCERPT_CHARS).collect();
        format!("{}...", cut.trim_end())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> History {
        History::open_in_memory().expect("in-memory db with FTS5")
    }

    fn add(h: &History, id: &str, at: u64, text: &str) {
        h.insert_capture(id, at, 100, 50, Source::Region).unwrap();
        assert!(h.set_ocr_text(id, text).unwrap());
    }

    fn ids(items: &[HistoryItem]) -> Vec<&str> {
        items.iter().map(|i| i.id.as_str()).collect()
    }

    #[test]
    fn list_is_newest_first_and_paged() {
        let h = db();
        for (i, id) in ["a", "b", "c", "d"].iter().enumerate() {
            add(&h, id, i as u64 + 1, "text");
        }
        assert_eq!(ids(&h.list(None, 10, 0).unwrap()), ["d", "c", "b", "a"]);
        assert_eq!(ids(&h.list(None, 2, 1).unwrap()), ["c", "b"]);
        assert_eq!(h.count().unwrap(), 4);
    }

    #[test]
    fn fts_search_matches_prefixes_and_all_terms() {
        let h = db();
        add(&h, "inv", 1, "Invoice 2024 total due Friday");
        add(&h, "err", 2, "Error: connection refused at 10.0.0.1");
        add(&h, "mix", 3, "invoice error report");
        assert_eq!(ids(&h.list(Some("invoi"), 10, 0).unwrap()), ["mix", "inv"]);
        assert_eq!(ids(&h.list(Some("INVOICE error"), 10, 0).unwrap()), ["mix"]);
        assert_eq!(ids(&h.list(Some("connection"), 10, 0).unwrap()), ["err"]);
        assert!(h.list(Some("nothing-matches"), 10, 0).unwrap().is_empty());
    }

    #[test]
    fn hostile_queries_cannot_break_the_fts_parser() {
        let h = db();
        add(&h, "a", 1, "hello world");
        for q in [
            "\"",
            "\"\"",
            "hello\" OR \"x",
            "hello NOT",
            "*",
            "a AND",
            "NEAR(a b)",
            "col:val",
            "(((",
            "x' OR 1=1 --",
            "hello; DROP TABLE captures",
            "\\",
            "-hello",
        ] {
            assert!(h.list(Some(q), 10, 0).is_ok(), "query {q:?} must not error");
        }
        assert_eq!(h.count().unwrap(), 1);
        // Operators are treated as plain words, not syntax.
        assert!(h.list(Some("hello NOT"), 10, 0).unwrap().is_empty()); // "not" is not in the text
        assert!(h.list(Some("hello AND world"), 10, 0).unwrap().is_empty()); // "and" absent
        assert_eq!(ids(&h.list(Some("world hello"), 10, 0).unwrap()), ["a"]);
    }

    #[test]
    fn fts_query_building() {
        assert_eq!(fts_query("hello world").unwrap(), "\"hello\"* \"world\"*");
        assert_eq!(fts_query("  a\"b  ").unwrap(), "\"a\"* \"b\"*");
        assert_eq!(fts_query("!!! ---"), None);
        assert_eq!(fts_query(""), None);
        let many = (0..20)
            .map(|i| format!("t{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            fts_query(&many).unwrap().matches('*').count(),
            MAX_QUERY_TOKENS
        );
        assert_eq!(fts_query("naïve café").unwrap(), "\"naïve\"* \"café\"*");
    }

    #[test]
    fn punctuation_only_query_matches_nothing_but_blank_query_lists_all() {
        let h = db();
        add(&h, "a", 1, "x");
        assert!(h.list(Some("!!!"), 10, 0).unwrap().is_empty());
        assert_eq!(h.list(Some("   "), 10, 0).unwrap().len(), 1);
        assert_eq!(h.list(Some(""), 10, 0).unwrap().len(), 1);
    }

    #[test]
    fn index_follows_ocr_updates() {
        let h = db();
        add(&h, "a", 1, "alpha beta");
        assert_eq!(h.list(Some("alpha"), 10, 0).unwrap().len(), 1);
        h.set_ocr_text("a", "gamma delta").unwrap();
        assert!(h.list(Some("alpha"), 10, 0).unwrap().is_empty());
        assert_eq!(h.list(Some("gamma"), 10, 0).unwrap().len(), 1);
    }

    #[test]
    fn delete_removes_row_and_index_entry() {
        let h = db();
        add(&h, "a", 1, "findable words");
        add(&h, "b", 2, "findable too");
        assert!(h.delete("a").unwrap());
        assert!(!h.delete("a").unwrap());
        assert_eq!(ids(&h.list(Some("findable"), 10, 0).unwrap()), ["b"]);
        assert!(h.get("a").unwrap().is_none());
    }

    #[test]
    fn clear_empties_everything_and_returns_ids() {
        let h = db();
        add(&h, "a", 1, "one");
        add(&h, "b", 2, "two");
        let mut removed = h.clear().unwrap();
        removed.sort();
        assert_eq!(removed, ["a", "b"]);
        assert_eq!(h.count().unwrap(), 0);
        assert!(h.list(Some("one"), 10, 0).unwrap().is_empty());
        // The index is usable again afterwards.
        add(&h, "c", 3, "three");
        assert_eq!(ids(&h.list(Some("three"), 10, 0).unwrap()), ["c"]);
    }

    #[test]
    fn documents_are_validated_and_flagged() {
        let h = db();
        h.insert_capture("a", 1, 10, 10, Source::Clipboard).unwrap();
        assert!(!h.list(None, 10, 0).unwrap()[0].has_doc);
        assert!(h.save_doc("a", "{not json").is_err());
        assert!(h
            .save_doc("a", &format!("\"{}\"", "x".repeat(MAX_DOC_BYTES)))
            .is_err());
        assert!(h.save_doc("a", r#"{"version":1}"#).unwrap());
        assert!(!h.save_doc("missing", "{}").unwrap());
        assert!(h.list(None, 10, 0).unwrap()[0].has_doc);
        let row = h.get("a").unwrap().unwrap();
        assert_eq!(row.doc_json.as_deref(), Some(r#"{"version":1}"#));
        assert_eq!(row.source, Source::Clipboard);
    }

    #[test]
    fn excerpts_are_flat_and_truncated() {
        let h = db();
        add(
            &h,
            "a",
            1,
            &format!("line one\n\nline   two {}", "w ".repeat(200)),
        );
        let item = &h.list(None, 10, 0).unwrap()[0];
        assert!(item.excerpt.starts_with("line one line two"));
        assert!(item.excerpt.ends_with("..."));
        assert!(item.excerpt.chars().count() <= EXCERPT_CHARS + 3);
    }

    #[test]
    fn the_list_never_reads_more_than_the_start_of_each_text() {
        let h = db();
        // A very long text whose searchable word is at the end still matches, but the excerpt
        // comes from the first characters only.
        let long = format!("start {} needle", "filler ".repeat(5_000));
        add(&h, "long", 1, &long);
        let all = h.list(None, 10, 0).unwrap();
        assert!(all[0].excerpt.starts_with("start filler"));
        assert!(all[0].excerpt.chars().count() <= EXCERPT_CHARS + 3);
        let found = h.list(Some("needle"), 10, 0).unwrap();
        assert_eq!(ids(&found), ["long"], "search still sees the whole text");
        assert!(!found[0].excerpt.contains("needle"));
        // Short texts are untouched.
        add(&h, "short", 2, "just this");
        assert_eq!(h.list(Some("just"), 10, 0).unwrap()[0].excerpt, "just this");
    }

    #[test]
    fn works_on_a_real_file_and_reopens() {
        let dir = std::env::temp_dir().join(format!("ps-history-{}", crate::ids::new_id()));
        let file = dir.join("history.db");
        {
            let h = History::open(&file).unwrap();
            add(&h, "p", 5, "persisted text");
        }
        let h = History::open(&file).unwrap();
        assert_eq!(ids(&h.list(Some("persisted"), 10, 0).unwrap()), ["p"]);
        drop(h);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
