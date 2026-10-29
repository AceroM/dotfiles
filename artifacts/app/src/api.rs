//! The server's JSON API and its `/events` stream. Every call blocks, so the view runs them on
//! GPUI's background executor.

use serde::Deserialize;
use std::io::{BufRead, BufReader, Read};

#[derive(Clone, Debug, Deserialize)]
pub struct Item {
    pub slug: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub slot: Option<i64>,
    #[serde(default)]
    pub ticket: Option<String>,
    pub updated_at: i64,
}

/// What the list is filtered by. `q` searches titles, tickets, branches and source, as the
/// server's own index does.
#[derive(Clone, Default, PartialEq)]
pub struct Query {
    pub q: String,
    pub kind: Option<String>,
    pub slot: Option<i64>,
}

pub fn base_url() -> String {
    std::env::var("ARTIFACTS_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:4620".into())
        .trim_end_matches('/')
        .to_string()
}

pub fn page_url(slug: &str) -> String {
    format!("{}/a/{slug}/", base_url())
}

/// The path of a URL on this server, under either host name (pages link relatively, the API
/// answers with `localhost`). None for anywhere else.
pub fn local_path(url: &str) -> Option<String> {
    let base = base_url();
    let other = if base.contains("127.0.0.1") { base.replace("127.0.0.1", "localhost") } else { base.replace("localhost", "127.0.0.1") };
    [base, other].iter().find_map(|b| {
        let rest = url.strip_prefix(b.as_str())?;
        match rest.chars().next() {
            None => Some("/".to_string()),
            Some('/' | '?' | '#') => Some(rest.to_string()),
            Some(_) => None,
        }
    })
}

fn list(query: &Query) -> Result<Vec<Item>, String> {
    let mut req = ureq::get(&format!("{}/api/artifacts", base_url())).query("limit", "1000");
    if !query.q.is_empty() {
        req = req.query("q", &query.q);
    }
    if let Some(kind) = &query.kind {
        req = req.query("kind", kind);
    }
    if let Some(slot) = query.slot {
        req = req.query("slot", &slot.to_string());
    }
    let resp = req.call().map_err(|e| e.to_string())?;
    resp.into_json().map_err(|e| e.to_string())
}

pub struct Fetched {
    /// The pages matching the query, for the list.
    pub items: Vec<Item>,
    /// Every page: the slot filter and the tab titles shouldn't shrink to the current results.
    pub all: Vec<Item>,
}

pub fn fetch(query: &Query) -> Result<Fetched, String> {
    let all = list(&Query::default())?;
    let items = if *query == Query::default() { all.clone() } else { list(query)? };
    Ok(Fetched { items, all })
}

/// The server's event stream: one `data:` line whenever a page is added, updated or removed.
pub struct Events(BufReader<Box<dyn Read + Send + Sync>>);

impl Events {
    pub fn connect() -> Result<Self, String> {
        let resp = ureq::get(&format!("{}/events", base_url())).call().map_err(|e| e.to_string())?;
        Ok(Self(BufReader::new(resp.into_reader())))
    }

    /// Blocks until the next event. An error means the stream ended (the server stopped).
    pub fn next(&mut self) -> Result<(), String> {
        let mut line = String::new();
        loop {
            line.clear();
            if self.0.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                return Err("the event stream closed".into());
            }
            if line.starts_with("data:") {
                return Ok(());
            }
        }
    }
}
