//! SQLite storage. One row per page with its current source and rendered HTML; every overwrite
//! moves the previous version into `revisions`, and screenshots live in `assets` as blobs.

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS artifacts (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT,
  question    TEXT,
  source      TEXT NOT NULL,
  html        TEXT NOT NULL,
  ctx         TEXT NOT NULL,
  repo        TEXT,
  slot        INTEGER,
  branch      TEXT,
  sha         TEXT,
  ticket      TEXT,
  source_file TEXT,
  session_id  TEXT,
  revision    INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_updated ON artifacts(updated_at DESC);
CREATE INDEX IF NOT EXISTS artifacts_source ON artifacts(source_file, session_id);
CREATE TABLE IF NOT EXISTS revisions (
  artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL,
  title       TEXT NOT NULL,
  source      TEXT NOT NULL,
  html        TEXT NOT NULL,
  ctx         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, revision)
);
CREATE TABLE IF NOT EXISTS assets (
  artifact_id  INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes        BLOB NOT NULL,
  PRIMARY KEY (artifact_id, name)
);
"#;

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub struct Db {
    conn: Connection,
}

pub struct Artifact {
    pub id: i64,
    pub slug: String,
    pub kind: String,
    pub title: String,
    pub summary: Option<String>,
    pub question: Option<String>,
    pub source: String,
    pub html: String,
    pub ctx: String,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct ListItem {
    pub slug: String,
    pub kind: String,
    pub title: String,
    pub summary: Option<String>,
    pub repo: Option<String>,
    pub slot: Option<i64>,
    pub branch: Option<String>,
    pub ticket: Option<String>,
    pub revision: i64,
    pub updated_at: i64,
}

pub struct Revision {
    pub revision: i64,
    pub title: String,
    pub html: String,
    pub ctx: String,
    pub created_at: i64,
}

/// What one `add` writes. `slug` set means "this page" (created if missing); unset means "the
/// page this file already made (in this agent session, for a temp file), else a new one".
pub struct Write<'a> {
    pub slug: Option<&'a str>,
    pub force_new: bool,
    pub kind: &'a str,
    pub title: &'a str,
    pub summary: Option<&'a str>,
    pub question: Option<&'a str>,
    pub source: &'a str,
    pub html: &'a str,
    pub ctx: &'a str,
    pub repo: Option<&'a str>,
    pub slot: Option<i64>,
    pub branch: Option<&'a str>,
    pub sha: Option<&'a str>,
    pub ticket: Option<&'a str>,
    pub source_file: Option<&'a str>,
    pub session_id: Option<&'a str>,
}

#[derive(Default)]
pub struct Filter {
    pub q: Option<String>,
    pub kind: Option<String>,
    pub slot: Option<i64>,
    pub limit: i64,
    pub offset: i64,
}

pub fn slugify(title: &str) -> String {
    let mut slug = String::new();
    for ch in title.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let mut slug = slug.trim_end_matches('-').to_string();
    if slug.len() > 60 {
        let cut = slug[..60].rfind('-').unwrap_or(60);
        slug.truncate(cut);
    }
    if slug.is_empty() {
        "untitled".into()
    } else {
        slug
    }
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Db> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Db { conn })
    }

    /// Insert or overwrite; returns the slug and the new revision number.
    pub fn save(&mut self, w: &Write) -> rusqlite::Result<(String, i64)> {
        let now = now();
        let tx = self.conn.transaction()?;
        let existing: Option<i64> = match (w.slug, w.source_file, w.session_id) {
            (Some(slug), _, _) => tx
                .query_row("SELECT id FROM artifacts WHERE slug = ?1", [slug], |r| r.get(0))
                .optional()?,
            // A file in a temp dir only means "the same page" within one agent session, since
            // another session can reuse the path. A file anywhere else (docs/, agents/) is one page.
            (None, Some(file), _) if !w.force_new && !is_temp(file) => tx
                .query_row(
                    "SELECT id FROM artifacts WHERE source_file = ?1 ORDER BY updated_at DESC LIMIT 1",
                    [file],
                    |r| r.get(0),
                )
                .optional()?,
            (None, Some(file), Some(session)) if !w.force_new => tx
                .query_row(
                    "SELECT id FROM artifacts WHERE source_file = ?1 AND session_id = ?2 ORDER BY updated_at DESC LIMIT 1",
                    params![file, session],
                    |r| r.get(0),
                )
                .optional()?,
            _ => None,
        };

        let saved = if let Some(id) = existing {
            tx.execute(
                "INSERT INTO revisions (artifact_id, revision, title, source, html, ctx, created_at)
                 SELECT id, revision, title, source, html, ctx, updated_at FROM artifacts WHERE id = ?1",
                [id],
            )?;
            tx.execute(
                "UPDATE artifacts SET kind = ?2, title = ?3, summary = COALESCE(?4, summary),
                   question = COALESCE(?5, question), source = ?6, html = ?7, ctx = ?8, repo = ?9,
                   slot = ?10, branch = ?11, sha = ?12, ticket = COALESCE(?13, ticket),
                   source_file = ?14, session_id = ?15, revision = revision + 1, updated_at = ?16
                 WHERE id = ?1",
                params![
                    id, w.kind, w.title, w.summary, w.question, w.source, w.html, w.ctx, w.repo,
                    w.slot, w.branch, w.sha, w.ticket, w.source_file, w.session_id, now
                ],
            )?;
            tx.query_row("SELECT slug, revision FROM artifacts WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
        } else {
            let slug = match w.slug {
                Some(slug) => slug.to_string(),
                None => unique_slug(&tx, &slugify(w.title))?,
            };
            tx.execute(
                "INSERT INTO artifacts (slug, kind, title, summary, question, source, html, ctx, repo,
                   slot, branch, sha, ticket, source_file, session_id, revision, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 1, ?16, ?16)",
                params![
                    slug, w.kind, w.title, w.summary, w.question, w.source, w.html, w.ctx, w.repo,
                    w.slot, w.branch, w.sha, w.ticket, w.source_file, w.session_id, now
                ],
            )?;
            (slug, 1)
        };
        tx.commit()?;
        Ok(saved)
    }

    pub fn list(&self, f: &Filter) -> rusqlite::Result<Vec<ListItem>> {
        let mut sql = String::from(
            "SELECT slug, kind, title, summary, repo, slot, branch, ticket, revision, updated_at FROM artifacts WHERE 1 = 1",
        );
        let mut args: Vec<rusqlite::types::Value> = vec![];
        if let Some(q) = f.q.as_deref().filter(|q| !q.is_empty()) {
            sql.push_str(
                " AND (title LIKE ? OR summary LIKE ? OR question LIKE ? OR slug LIKE ? OR ticket LIKE ? OR branch LIKE ? OR source LIKE ?)",
            );
            let like = format!("%{q}%");
            args.extend(std::iter::repeat(rusqlite::types::Value::Text(like)).take(7));
        }
        if let Some(kind) = f.kind.as_deref().filter(|k| !k.is_empty()) {
            sql.push_str(" AND kind = ?");
            args.push(rusqlite::types::Value::Text(kind.to_string()));
        }
        if let Some(slot) = f.slot {
            sql.push_str(" AND slot = ?");
            args.push(rusqlite::types::Value::Integer(slot));
        }
        sql.push_str(" ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?");
        args.push(rusqlite::types::Value::Integer(if f.limit > 0 { f.limit } else { 200 }));
        args.push(rusqlite::types::Value::Integer(f.offset.max(0)));

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args), |r| {
            Ok(ListItem {
                slug: r.get(0)?,
                kind: r.get(1)?,
                title: r.get(2)?,
                summary: r.get(3)?,
                repo: r.get(4)?,
                slot: r.get(5)?,
                branch: r.get(6)?,
                ticket: r.get(7)?,
                revision: r.get(8)?,
                updated_at: r.get(9)?,
            })
        })?;
        rows.collect()
    }

    pub fn get(&self, slug: &str) -> rusqlite::Result<Option<Artifact>> {
        self.conn
            .query_row(
                "SELECT id, slug, kind, title, summary, question, source, html, ctx, revision, created_at, updated_at
                 FROM artifacts WHERE slug = ?1",
                [slug],
                |r| {
                    Ok(Artifact {
                        id: r.get(0)?,
                        slug: r.get(1)?,
                        kind: r.get(2)?,
                        title: r.get(3)?,
                        summary: r.get(4)?,
                        question: r.get(5)?,
                        source: r.get(6)?,
                        html: r.get(7)?,
                        ctx: r.get(8)?,
                        revision: r.get(9)?,
                        created_at: r.get(10)?,
                        updated_at: r.get(11)?,
                    })
                },
            )
            .optional()
    }

    /// Earlier versions, newest first.
    pub fn revisions(&self, artifact_id: i64) -> rusqlite::Result<Vec<(i64, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT revision, created_at FROM revisions WHERE artifact_id = ?1 ORDER BY revision DESC",
        )?;
        let rows = stmt.query_map([artifact_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    pub fn revision(&self, artifact_id: i64, revision: i64) -> rusqlite::Result<Option<Revision>> {
        self.conn
            .query_row(
                "SELECT revision, title, html, ctx, created_at FROM revisions WHERE artifact_id = ?1 AND revision = ?2",
                params![artifact_id, revision],
                |r| {
                    Ok(Revision {
                        revision: r.get(0)?,
                        title: r.get(1)?,
                        html: r.get(2)?,
                        ctx: r.get(3)?,
                        created_at: r.get(4)?,
                    })
                },
            )
            .optional()
    }

    /// Returns false when there is no such page.
    pub fn put_asset(&self, slug: &str, name: &str, content_type: &str, bytes: &[u8]) -> rusqlite::Result<bool> {
        let changed = self.conn.execute(
            "INSERT INTO assets (artifact_id, name, content_type, bytes)
             SELECT id, ?2, ?3, ?4 FROM artifacts WHERE slug = ?1
             ON CONFLICT (artifact_id, name) DO UPDATE SET content_type = excluded.content_type, bytes = excluded.bytes",
            params![slug, name, content_type, bytes],
        )?;
        Ok(changed > 0)
    }

    pub fn asset(&self, slug: &str, name: &str) -> rusqlite::Result<Option<(String, Vec<u8>)>> {
        self.conn
            .query_row(
                "SELECT a.content_type, a.bytes FROM assets a JOIN artifacts x ON x.id = a.artifact_id
                 WHERE x.slug = ?1 AND a.name = ?2",
                params![slug, name],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
    }

    pub fn delete(&self, slug: &str) -> rusqlite::Result<bool> {
        Ok(self.conn.execute("DELETE FROM artifacts WHERE slug = ?1", [slug])? > 0)
    }

    /// The slugs just above (newer) and below (older) a page in the index's order.
    pub fn neighbors(&self, updated_at: i64, id: i64) -> rusqlite::Result<(Option<String>, Option<String>)> {
        let newer = self
            .conn
            .query_row(
                "SELECT slug FROM artifacts WHERE updated_at > ?1 OR (updated_at = ?1 AND id > ?2)
                 ORDER BY updated_at ASC, id ASC LIMIT 1",
                params![updated_at, id],
                |r| r.get(0),
            )
            .optional()?;
        let older = self
            .conn
            .query_row(
                "SELECT slug FROM artifacts WHERE updated_at < ?1 OR (updated_at = ?1 AND id < ?2)
                 ORDER BY updated_at DESC, id DESC LIMIT 1",
                params![updated_at, id],
                |r| r.get(0),
            )
            .optional()?;
        Ok((newer, older))
    }

    pub fn slots(&self) -> rusqlite::Result<Vec<i64>> {
        let mut stmt = self.conn.prepare("SELECT DISTINCT slot FROM artifacts WHERE slot IS NOT NULL ORDER BY slot")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect()
    }
}

fn is_temp(path: &str) -> bool {
    ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"].iter().any(|p| path.starts_with(p))
}

fn unique_slug(tx: &rusqlite::Transaction, base: &str) -> rusqlite::Result<String> {
    let mut candidate = base.to_string();
    let mut n = 2;
    loop {
        let taken: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM artifacts WHERE slug = ?1)", [&candidate], |r| r.get(0))?;
        if !taken {
            return Ok(candidate);
        }
        candidate = format!("{base}-{n}");
        n += 1;
    }
}
