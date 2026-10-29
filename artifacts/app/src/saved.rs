//! What the app keeps across launches: the open tabs, the page zoom and the sidebar (its width
//! and whether ⌘B hid it), in
//! `$XDG_DATA_HOME/artifacts/app.json` (else `~/.local/share/artifacts/app.json`), beside the
//! server's page store.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Saved {
    /// The slugs open in tabs, left to right.
    pub tabs: Vec<String>,
    pub active: usize,
    pub zoom: Option<f64>,
    pub sidebar_width: Option<f32>,
    pub sidebar_hidden: bool,
}

fn path() -> PathBuf {
    let data = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| format!("{}/.local/share", std::env::var("HOME").unwrap_or_default()));
    PathBuf::from(data).join("artifacts/app.json")
}

pub fn load() -> Saved {
    std::fs::read_to_string(path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save(saved: &Saved) {
    let path = path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(saved) {
        let _ = std::fs::write(path, json);
    }
}
