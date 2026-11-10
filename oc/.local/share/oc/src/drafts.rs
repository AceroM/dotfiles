//! Drafts: prompts kept for later (^s), gone through with ^g. They are al's
//! drafts, in al's file, so a draft written here waits on top of al's tab
//! list and one written there shows up here:
//!
//!   $XDG_STATE_HOME/al/drafts.json        (else ~/.local/state/al)
//!   $XDG_STATE_HOME/al/drafts/<id>/N.png  the file behind `[Image #N]`
//!
//! A draft belongs to the Herdr space it was written in. The file is read
//! fresh before each write and written whole (to a temp file, then renamed),
//! as al does, so the two don't lose each other's drafts. The code is al's
//! drafts.rs, less the pictures.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// The agent a reply goes to (al's `D`): its pane, the tab it was in and
/// what that tab was called, and its session.
#[derive(Clone, Debug, PartialEq)]
pub struct ReplyTo {
    pub pane: String,
    pub tab: String,
    pub label: String,
    pub session: Option<String>,
}

impl ReplyTo {
    fn to_json(&self) -> Value {
        json!({ "pane": self.pane, "tab": self.tab, "label": self.label, "session": self.session })
    }

    fn from_json(v: &Value) -> Option<ReplyTo> {
        let s = |k: &str| v[k].as_str().map(String::from);
        Some(ReplyTo { pane: s("pane")?, tab: s("tab").unwrap_or_default(), label: s("label").unwrap_or_default(), session: s("session") })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    pub id: String,
    /// The Herdr space it was written in: its id, and its name (the id can
    /// change when Herdr starts over; the name usually doesn't).
    pub workspace: String,
    pub space: String,
    /// Where its agent starts.
    pub cwd: PathBuf,
    /// The prompt, `[Image #N]` tags and all.
    pub text: String,
    /// The file behind each tag: `[Image #N]` is `images[N - 1]`.
    pub images: Vec<PathBuf>,
    /// Seconds since the epoch.
    pub created: u64,
    /// A reply: ⏎ sends it to this agent. None starts a new one in `cwd`.
    pub reply: Option<ReplyTo>,
    /// The kind of agent a new one is: claude, codex. None: the default.
    pub kind: Option<String>,
    /// oc's configuration of it, by name (`claude(fable)`; config.rs). al
    /// doesn't keep it: without it, the first configuration of `kind`.
    pub config: Option<String>,
    /// It goes as `/plan …`.
    pub plan: bool,
}

impl Draft {
    /// Whether it shows in the space `ws` named `space`.
    pub fn belongs(&self, ws: &str, space: &str) -> bool {
        self.workspace == ws || (!space.is_empty() && self.space == space)
    }

    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "workspace": self.workspace,
            "space": self.space,
            "cwd": self.cwd,
            "text": self.text,
            "images": self.images,
            "created": self.created,
            "reply": self.reply.as_ref().map(ReplyTo::to_json),
            "kind": self.kind,
            "config": self.config,
            "plan": self.plan,
        })
    }

    fn from_json(v: &Value) -> Option<Draft> {
        let s = |k: &str| v[k].as_str().map(String::from);
        Some(Draft {
            id: s("id")?,
            workspace: s("workspace").unwrap_or_default(),
            space: s("space").unwrap_or_default(),
            cwd: s("cwd")?.into(),
            text: s("text")?,
            images: v["images"].as_array().map(|a| a.iter().filter_map(|p| p.as_str().map(PathBuf::from)).collect()).unwrap_or_default(),
            created: v["created"].as_u64().unwrap_or(0),
            reply: ReplyTo::from_json(&v["reply"]),
            kind: s("kind"),
            config: s("config"),
            plan: v["plan"].as_bool().unwrap_or(false),
        })
    }
}

/// al's state folder.
fn state_dir() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME").filter(|s| !s.is_empty()).map(PathBuf::from);
    base.unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/state")).join("al")
}

fn file() -> PathBuf {
    state_dir().join("drafts.json")
}

/// Where draft `id` keeps its images.
fn image_dir(id: &str) -> PathBuf {
    state_dir().join("drafts").join(id)
}

/// When the file last changed: it's read again when this moves.
pub fn stamp() -> Option<SystemTime> {
    std::fs::metadata(file()).and_then(|m| m.modified()).ok()
}

/// Every draft, newest first.
pub fn load() -> Vec<Draft> {
    let Ok(s) = std::fs::read_to_string(file()) else { return Vec::new() };
    let v: Value = serde_json::from_str(&s).unwrap_or(Value::Null);
    v["drafts"].as_array().map(|a| a.iter().filter_map(Draft::from_json).collect()).unwrap_or_default()
}

fn store(all: &[Draft]) -> Result<(), String> {
    let path = file();
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let body = json!({ "drafts": all.iter().map(Draft::to_json).collect::<Vec<_>>() });
    let tmp = dir.join(format!(".drafts.json.{}", std::process::id()));
    let text = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Add `d`, or replace the draft with its id where it stands. Read fresh
/// first, so al's drafts (and another oc's) aren't lost.
pub fn put(d: &Draft) -> Result<(), String> {
    let mut all = load();
    match all.iter_mut().find(|x| x.id == d.id) {
        Some(x) => *x = d.clone(),
        None => all.insert(0, d.clone()),
    }
    store(&all)
}

/// Take draft `id` out. Its images stay a while (al sweeps the folders after
/// three days): `u` brings a deleted draft back, and a draft's agent reads
/// them after it runs.
pub fn remove(id: &str) -> Result<(), String> {
    let mut all = load();
    all.retain(|d| d.id != id);
    store(&all)?;
    // Folder written to now: al's sweep counts its days from here.
    let _ = std::fs::write(image_dir(id).join(".left"), "");
    Ok(())
}

/// A new draft's id: the time and this oc's count, in base 36.
pub fn new_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    format!("{}-{}-{}", base36(ms), base36(u64::from(std::process::id())), base36(SEQ.fetch_add(1, Ordering::Relaxed)))
}

fn base36(mut n: u64) -> String {
    let mut s = Vec::new();
    while n > 0 || s.is_empty() {
        s.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
    }
    s.reverse();
    String::from_utf8(s).unwrap_or_default()
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Copy the images `text` still tags into draft `id`'s folder, so they last
/// as long as it does (a pasted image lives in $TMPDIR, which macOS
/// empties). Returns the list with the copies in place; a file that can't be
/// copied keeps its old path.
pub fn keep_images(id: &str, text: &str, images: &[PathBuf]) -> Vec<PathBuf> {
    let dir = image_dir(id);
    let mut out = images.to_vec();
    for (_, n) in crate::field::image_tags(text) {
        let Some(p) = n.checked_sub(1).and_then(|i| out.get_mut(i)) else { continue };
        if p.starts_with(&dir) {
            continue;
        }
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("png").to_ascii_lowercase();
        let to = dir.join(format!("{n}.{ext}"));
        if std::fs::create_dir_all(&dir).is_ok() && std::fs::copy(&*p, &to).is_ok() {
            *p = to;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_json_as_al_writes_it() {
        let mut d = Draft {
            id: "x".into(),
            workspace: "w1".into(),
            space: "dots".into(),
            cwd: "/tmp".into(),
            text: "look at [Image #1]\nand fix it".into(),
            images: vec!["/a/1.png".into()],
            created: 1,
            reply: None,
            kind: Some("codex".into()),
            config: Some("codex".into()),
            plan: true,
        };
        assert_eq!(Draft::from_json(&d.to_json()), Some(d.clone()));
        d.reply = Some(ReplyTo { pane: "w1:p3".into(), tab: "w1:t2".into(), label: "auth_tests".into(), session: None });
        assert_eq!(Draft::from_json(&d.to_json()), Some(d.clone()));
        assert!(d.belongs("w1", "") && d.belongs("w9", "dots") && !d.belongs("w9", ""));
    }
}
