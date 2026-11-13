//! What ⌥⌘N shows over a pane (float_here in rex/.config/rex/init.lua): the
//! images behind its `[Image #N]` tags, one small JSON file per Rex block in
//! ~/.local/state/o/panes, always there (not $XDG_STATE_HOME) since Rex's
//! config reads it too:
//!
//!   {"kind": "prompt", "images": [{"n": 1, "path": "/…/paste-….png"}, …]}
//!
//! `prompt`: o's own pane, the images the prompt tags now (the selected
//! draft's, in the list), rewritten as they change and gone when there are
//! none or o quits. `sent`: an agent's tab, the images o last sent it. `o
//! --images BLOCK` (viewer.rs) draws them.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

/// A pane's images: `[Image #n]` and its file.
pub type Tagged = Vec<(usize, PathBuf)>;

pub const PROMPT: &str = "prompt";
pub const SENT: &str = "sent";

pub fn dir() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/state/o/panes")
}

/// Block `block`'s file: its ID without `block:` (init.lua names it the same way).
pub fn file(block: &str) -> PathBuf {
    let id: String = block.trim_start_matches("block:").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    dir().join(format!("{id}.json"))
}

/// Keep `images` as block `block`'s, of `kind`; none: its file goes.
pub fn write(block: &str, kind: &str, images: &[(usize, PathBuf)]) {
    write_to(&file(block), kind, images);
}

fn write_to(path: &Path, kind: &str, images: &[(usize, PathBuf)]) {
    if images.is_empty() {
        let _ = std::fs::remove_file(path);
        return;
    }
    let list: Vec<Value> = images.iter().map(|(n, p)| json!({ "n": n, "path": p })).collect();
    let body = json!({ "kind": kind, "images": list }).to_string();
    // Whole or not at all: the viewer reads it as it changes.
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    if path.parent().is_some_and(|d| std::fs::create_dir_all(d).is_ok()) && std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// A pane's file: its kind and images. None when it isn't there (or isn't one).
pub fn read(path: &Path) -> Option<(String, Tagged)> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let kind = v["kind"].as_str().unwrap_or(PROMPT).to_string();
    let images = v["images"].as_array()?.iter().filter_map(|i| Some((usize::try_from(i["n"].as_u64()?).ok()?, PathBuf::from(i["path"].as_str()?)))).collect();
    Some((kind, images))
}

/// The files of panes long closed: three days untouched (as drafts::sweep).
pub fn sweep() {
    const AGE: Duration = Duration::from_secs(3 * 24 * 3600);
    let Ok(rd) = std::fs::read_dir(dir()) else { return };
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|a| a > AGE);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_blocks_file_by_its_id() {
        let f = file("block:01a1d24d-dbd4-7274-99c2-c50db953ded1");
        assert_eq!(f.file_name().unwrap(), "01a1d24d-dbd4-7274-99c2-c50db953ded1.json");
        assert!(f.ends_with(".local/state/o/panes/01a1d24d-dbd4-7274-99c2-c50db953ded1.json"));
        // Nothing that would leave the folder.
        assert_eq!(file("block:../x").file_name().unwrap(), "x.json");
    }

    #[test]
    fn writes_reads_and_removes() {
        let dir = std::env::temp_dir().join(format!("o-panes-test-{}", std::process::id()));
        let f = dir.join("b.json");
        let imgs = vec![(1, PathBuf::from("/a.png")), (3, PathBuf::from("/c d.png"))];
        write_to(&f, SENT, &imgs);
        assert_eq!(read(&f), Some((SENT.to_string(), imgs)));
        let raw = std::fs::read_to_string(&f).unwrap();
        assert_eq!(raw, r#"{"images":[{"n":1,"path":"/a.png"},{"n":3,"path":"/c d.png"}],"kind":"sent"}"#);
        write_to(&f, PROMPT, &[]);
        assert!(!f.exists());
        assert_eq!(read(&f), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
