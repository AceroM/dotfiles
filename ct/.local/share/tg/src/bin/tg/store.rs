//! Chrome's saved tab groups, read from its sync store: `<profile>/Sync Data/LevelDB`, a LevelDB
//! that Chrome keeps locked and appends to while it runs. tg copies the files to a directory of
//! its own and opens the copy, so Chrome's store is only ever read.
//!
//! Each saved group is one `saved_tab_group-dt-<guid>` record and each of its tabs another, all
//! `SavedTabGroupData` protos (components/saved_tab_groups/proto). Field numbers used here:
//!
//! ```text
//! SavedTabGroupData      2: specifics
//!   specifics            1: guid  2: created (µs since 1601)  3: updated  4: group  5: tab
//!     group              2: title  3: color (1 grey … 9 orange)  4: position on the bookmarks bar
//!     tab                1: group guid  2: position  3: url  4: title
//! ```
//!
//! Tab records whose group record is gone are leftovers Chrome ignores; so does tg.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rusty_leveldb::{LdbIterator, Options, DB};

#[derive(Clone)]
pub struct SavedGroup {
    pub guid: String,
    /// Empty for a group nobody named (Chrome calls it "1 Tab", "3 Tabs").
    pub title: String,
    /// Chrome's name for it: `grey`, `blue`, … `orange`.
    pub color: &'static str,
    /// Its place on the bookmarks bar; None when it isn't pinned there.
    pub pinned: Option<i64>,
    /// Unix ms.
    pub created: f64,
    pub updated: f64,
    /// In order.
    pub tabs: Vec<SavedTab>,
}

#[derive(Clone)]
pub struct SavedTab {
    pub url: String,
    pub title: String,
    position: i64,
}

/// The profile's sync store. `profile` is the directory name (`Default`, `Profile 1`); without
/// one, the profile Chrome used last.
pub fn locate(browser_exe: &Path, profile: Option<&str>) -> Result<PathBuf, String> {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let support = home.join("Library/Application Support");
    let exe = browser_exe.to_string_lossy();
    let user_data = if exe.contains("Google Chrome Canary.app") {
        support.join("Google/Chrome Canary")
    } else if exe.contains("Google Chrome Beta.app") {
        support.join("Google/Chrome Beta")
    } else if exe.contains("Google Chrome Dev.app") {
        support.join("Google/Chrome Dev")
    } else if exe.contains("Google Chrome.app") {
        support.join("Google/Chrome")
    } else if exe.contains("Chromium.app") {
        support.join("Chromium")
    } else {
        return Err(format!("tg reads Chrome's saved tab groups, and {exe} isn't Chrome"));
    };
    let profile = match profile {
        Some(p) => p.to_string(),
        None => {
            let local: serde_json::Value = std::fs::read(user_data.join("Local State"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or_default();
            local["profile"]["last_used"].as_str().unwrap_or("Default").to_string()
        }
    };
    let dir = user_data.join(&profile).join("Sync Data/LevelDB");
    if !dir.join("CURRENT").exists() {
        return Err(format!("no sync store at {} (--profile picks another profile)", dir.display()));
    }
    Ok(dir)
}

/// When the store last changed: its newest file.
pub fn stamp(dir: &Path) -> Option<SystemTime> {
    std::fs::read_dir(dir).ok()?.flatten().filter_map(|e| e.metadata().ok()?.modified().ok()).max()
}

/// Every saved group with its tabs. `scratch` is where the copy goes (emptied first).
pub fn read(dir: &Path, scratch: &Path) -> Result<Vec<SavedGroup>, String> {
    // Chrome may compact between listing and copying; a second try sees the new files.
    let mut last = String::new();
    for _ in 0..3 {
        match read_once(dir, scratch) {
            Ok(g) => return Ok(g),
            Err(e) => last = e,
        }
    }
    Err(format!("couldn't read Chrome's saved groups: {last}"))
}

fn read_once(dir: &Path, scratch: &Path) -> Result<Vec<SavedGroup>, String> {
    let _ = std::fs::remove_dir_all(scratch);
    std::fs::create_dir_all(scratch).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name();
        if name == "LOCK" || name == "LOG" || name == "LOG.old" {
            continue;
        }
        std::fs::copy(e.path(), scratch.join(&name)).map_err(|err| format!("{}: {err}", name.to_string_lossy()))?;
    }
    let mut opts = Options::default();
    opts.create_if_missing = false;
    let mut db = DB::open(scratch, opts).map_err(|e| e.to_string())?;
    let mut it = db.new_iter().map_err(|e| e.to_string())?;
    const PREFIX: &[u8] = b"saved_tab_group-dt-";
    it.seek(PREFIX);
    let mut groups: Vec<SavedGroup> = Vec::new();
    let mut tabs: HashMap<String, Vec<SavedTab>> = HashMap::new();
    while let Some((k, v)) = it.current() {
        if !k.starts_with(PREFIX) {
            break;
        }
        match decode(&v) {
            Some(Record::Group(g)) => groups.push(g),
            Some(Record::Tab(group, t)) => tabs.entry(group).or_default().push(t),
            None => {}
        }
        if !it.advance() {
            break;
        }
    }
    drop(it);
    drop(db);
    let _ = std::fs::remove_dir_all(scratch);
    for g in &mut groups {
        let mut t = tabs.remove(&g.guid).unwrap_or_default();
        t.sort_by_key(|t| t.position);
        g.tabs = t;
    }
    Ok(groups)
}

enum Record {
    Group(SavedGroup),
    Tab(String, SavedTab),
}

fn decode(data: &[u8]) -> Option<Record> {
    let top = fields(data)?;
    // SavedTabGroupData wraps the specifics in field 2; older stores kept the specifics bare.
    let spec = match bytes(&top, 2) {
        Some(s) if fields(s).is_some_and(|f| text(&f, 1).len() == 36) => fields(s)?,
        _ => top,
    };
    let guid = text(&spec, 1);
    if guid.is_empty() {
        return None;
    }
    let time = |n| int(&spec, n).map_or(0.0, |us| us as f64 / 1000.0 - 11_644_473_600_000.0);
    if let Some(g) = bytes(&spec, 4).and_then(fields) {
        return Some(Record::Group(SavedGroup {
            guid,
            title: text(&g, 2),
            color: color_name(int(&g, 3).unwrap_or(0)),
            pinned: int(&g, 4).map(|p| p as i64).filter(|&p| p >= 0),
            created: time(2),
            updated: time(3),
            tabs: Vec::new(),
        }));
    }
    if let Some(t) = bytes(&spec, 5).and_then(fields) {
        let group = text(&t, 1);
        return Some(Record::Tab(group, SavedTab { url: text(&t, 3), title: text(&t, 4), position: int(&t, 2).unwrap_or(0) as i64 }));
    }
    None
}

fn color_name(n: u64) -> &'static str {
    match n {
        2 => "blue",
        3 => "red",
        4 => "yellow",
        5 => "green",
        6 => "pink",
        7 => "purple",
        8 => "cyan",
        9 => "orange",
        _ => "grey",
    }
}

// ---- a protobuf reader, just enough for these records ---------------------------

enum Val<'a> {
    Int(u64),
    Bytes(&'a [u8]),
}

fn varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let mut r = 0u64;
    for shift in (0..64).step_by(7) {
        let x = *b.get(*i)?;
        *i += 1;
        r |= ((x & 0x7f) as u64) << shift;
        if x & 0x80 == 0 {
            return Some(r);
        }
    }
    None
}

/// The message's fields, in order; None when it doesn't parse as one.
fn fields(b: &[u8]) -> Option<Vec<(u64, Val<'_>)>> {
    let mut i = 0;
    let mut out = Vec::new();
    while i < b.len() {
        let key = varint(b, &mut i)?;
        let (field, wire) = (key >> 3, key & 7);
        if field == 0 {
            return None;
        }
        match wire {
            0 => out.push((field, Val::Int(varint(b, &mut i)?))),
            1 => i = i.checked_add(8).filter(|&e| e <= b.len())?,
            5 => i = i.checked_add(4).filter(|&e| e <= b.len())?,
            2 => {
                let n = varint(b, &mut i)? as usize;
                let end = i.checked_add(n).filter(|&e| e <= b.len())?;
                out.push((field, Val::Bytes(&b[i..end])));
                i = end;
            }
            _ => return None,
        }
    }
    Some(out)
}

fn int(f: &[(u64, Val)], n: u64) -> Option<u64> {
    f.iter().rev().find_map(|(k, v)| match v {
        Val::Int(x) if *k == n => Some(*x),
        _ => None,
    })
}

fn bytes<'a>(f: &[(u64, Val<'a>)], n: u64) -> Option<&'a [u8]> {
    f.iter().rev().find_map(|(k, v)| match v {
        Val::Bytes(x) if *k == n => Some(*x),
        _ => None,
    })
}

fn text(f: &[(u64, Val)], n: u64) -> String {
    bytes(f, n).map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default()
}
