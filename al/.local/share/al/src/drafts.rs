//! Drafts: prompts written with `d` that wait on top of the tab list until ⏎
//! starts an agent with them, and replies written with `D` (or saved from the
//! `r` box with ^s) that wait until ⏎ sends them to the agent they answer.
//! They outlive al: one JSON file, and each
//! draft's images copied beside it (a pasted image lives in $TMPDIR, which
//! macOS empties).
//!
//!   $XDG_STATE_HOME/al/drafts.json        (else ~/.local/state/al)
//!   $XDG_STATE_HOME/al/drafts/<id>/N.png  the file behind `[Image #N]`
//!
//! A draft belongs to the Herdr space it was written in. Every al rereads the
//! file when it changes and writes it whole (to a temp file, then renamed), so
//! two als on one space see each other's drafts.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::gfx;

/// The agent a reply goes to: its pane, the tab it was in and what that tab
/// was called, and its session (the pane is looked for first, then the
/// session, in case the agent moved).
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
    /// The kind of agent a new one is (shift+tab): claude, codex. None, from
    /// before there was a choice: the default (agent::agents).
    pub kind: Option<String>,
    /// ^p: it goes as `/plan …`, in plan mode.
    pub plan: bool,
}

/// A prompt on one line: what the `/` filter searches.
pub fn flat(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A prompt's first line with words in it, spaced as `flat` spaces it (so
/// it starts `flat`, and the filter's hits line up): what the list shows.
pub fn first_line(text: &str) -> String {
    text.lines().map(flat).find(|l| !l.is_empty()).unwrap_or_default()
}

/// The images `text`'s tags still point at, in tag order: (N, file).
pub fn tagged(text: &str, images: &[PathBuf]) -> Vec<(usize, PathBuf)> {
    let mut nums: Vec<usize> = crate::agent::image_tags(text).into_iter().map(|(_, n)| n).collect();
    nums.sort_unstable();
    nums.dedup();
    nums.into_iter().filter_map(|n| Some((n, images.get(n.checked_sub(1)?)?.clone()))).collect()
}

impl Draft {
    /// The prompt on one line, for the list.
    pub fn flat(&self) -> String {
        flat(&self.text)
    }

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
            plan: v["plan"].as_bool().unwrap_or(false),
        })
    }
}

/// al's state folder.
pub fn state_dir() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME").filter(|s| !s.is_empty()).map(PathBuf::from);
    base.unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/state")).join("al")
}

fn file() -> PathBuf {
    state_dir().join("drafts.json")
}

/// Where draft `id` keeps its images.
pub fn image_dir(id: &str) -> PathBuf {
    state_dir().join("drafts").join(id)
}

/// When the file last changed: al rereads it when this moves.
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
/// first, so another al's drafts aren't lost.
pub fn put(d: &Draft) -> Result<(), String> {
    let mut all = load();
    match all.iter_mut().find(|x| x.id == d.id) {
        Some(x) => *x = d.clone(),
        None => all.insert(0, d.clone()),
    }
    store(&all)
}

/// Take draft `id` out. Its images stay a while (see `sweep`): `u` brings a
/// deleted draft back, and a draft's agent reads them after it runs.
pub fn remove(id: &str) -> Result<(), String> {
    let mut all = load();
    all.retain(|d| d.id != id);
    store(&all)?;
    // Folder written to now: `sweep` counts its days from here.
    let _ = std::fs::write(image_dir(id).join(".left"), "");
    Ok(())
}

/// A new draft's id: the time and this al's count, in base 36 (two in one
/// millisecond, as `--keys` makes them, still differ).
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

/// Copy the images `text` still tags into draft `id`'s folder, so they last as
/// long as it does. Returns the list with the copies in place; a file that
/// can't be copied keeps its old path.
pub fn keep_images(id: &str, text: &str, images: &[PathBuf]) -> Vec<PathBuf> {
    let dir = image_dir(id);
    let mut out = images.to_vec();
    for (_, n) in crate::agent::image_tags(text) {
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

/// Delete image folders no draft has used for three days. In a thread, at start.
pub fn sweep() {
    const AGE: Duration = Duration::from_secs(3 * 24 * 3600);
    let ids: Vec<String> = load().into_iter().map(|d| d.id).collect();
    let Ok(rd) = std::fs::read_dir(state_dir().join("drafts")) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|a| a > AGE);
        if old && !ids.contains(&name) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

// ---- pictures ----------------------------------------------------------------

/// An image ready for the terminal: its size in pixels and the PNG, in base64.
pub struct Pic {
    pub w: u32,
    pub h: u32,
    pub b64: String,
}

/// Biggest side sent to the terminal, as ctab's screenshots: plenty for a
/// preview, and a 5K screenshot doesn't crawl through the pty.
const MAX_SIDE: u32 = 1600;
const MAX_BYTES: usize = 2_500_000;

/// `path` as a PNG no bigger than MAX_SIDE. A small PNG goes as it is; sips
/// (macOS) turns anything else into one. Slow-ish: call it off the UI thread.
pub fn load_pic(path: &Path) -> Result<Pic, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if let Some((w, h)) = gfx::png_size(&bytes) {
        if w <= MAX_SIDE && h <= MAX_SIDE && bytes.len() <= MAX_BYTES {
            return Ok(Pic { w, h, b64: gfx::base64(&bytes) });
        }
    }
    let dir = std::env::temp_dir().join("al");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("pic-{}-{}.png", std::process::id(), new_id()));
    let sips = |args: &[&str], src: &Path| {
        Command::new("sips")
            .args(args)
            .arg(src)
            .arg("--out")
            .arg(&out)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    if !sips(&["-s", "format", "png"], path) {
        return Err("sips couldn't read it".into());
    }
    let mut png = std::fs::read(&out).map_err(|e| e.to_string())?;
    let (mut w, mut h) = gfx::png_size(&png).ok_or("not an image")?;
    // -Z scales up as well as down, so only when it's too big.
    if w.max(h) > MAX_SIDE || png.len() > MAX_BYTES {
        let side = MAX_SIDE.min(w.max(h)).to_string();
        let tmp = dir.join(format!("pic-{}-{}-src.png", std::process::id(), new_id()));
        let _ = std::fs::rename(&out, &tmp);
        let ok = sips(&["-s", "format", "png", "-Z", &side], &tmp);
        let _ = std::fs::remove_file(&tmp);
        if !ok {
            return Err("sips couldn't shrink it".into());
        }
        png = std::fs::read(&out).map_err(|e| e.to_string())?;
        (w, h) = gfx::png_size(&png).ok_or("not an image")?;
    }
    let _ = std::fs::remove_file(&out);
    Ok(Pic { w, h, b64: gfx::base64(&png) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(text: &str, images: &[&str]) -> Draft {
        Draft {
            id: "x".into(),
            workspace: "w1".into(),
            space: "dots".into(),
            cwd: "/tmp".into(),
            text: text.into(),
            images: images.iter().map(PathBuf::from).collect(),
            created: 1,
            reply: None,
            kind: None,
            plan: false,
        }
    }

    #[test]
    fn round_trips_json() {
        let mut d = draft("look at [Image #1]\nand fix it", &["/a/1.png"]);
        assert_eq!(Draft::from_json(&d.to_json()), Some(d.clone()));
        (d.kind, d.plan) = (Some("codex".into()), true);
        assert_eq!(Draft::from_json(&d.to_json()), Some(d));
    }

    #[test]
    fn round_trips_a_reply() {
        let mut d = draft("and the footer too", &[]);
        d.reply = Some(ReplyTo { pane: "w1:p3".into(), tab: "w1:t2".into(), label: "auth_tests".into(), session: Some("abc".into()) });
        assert_eq!(Draft::from_json(&d.to_json()), Some(d.clone()));
        d.reply.as_mut().unwrap().session = None;
        assert_eq!(Draft::from_json(&d.to_json()), Some(d));
        // A draft from before replies: a new agent's.
        let old = json!({ "id": "x", "cwd": "/tmp", "text": "hi" });
        assert_eq!(Draft::from_json(&old).map(|d| (d.reply, d.kind, d.plan)), Some((None, None, false)));
    }

    #[test]
    fn lists_the_tagged_images_in_order() {
        let d = draft("[Image #3] then [Image #1] and [Image #1] again, [Image #9]", &["/1.png", "/2.png", "/3.png"]);
        assert_eq!(tagged(&d.text, &d.images), vec![(1, PathBuf::from("/1.png")), (3, PathBuf::from("/3.png"))]);
    }

    #[test]
    fn flattens_and_scopes() {
        let d = draft("one\n\ntwo   three", &[]);
        assert_eq!(d.flat(), "one two three");
        assert_eq!(first_line(&d.text), "one");
        assert_eq!(first_line("\n  \n  fix   the header\nand more"), "fix the header");
        assert_eq!(first_line(""), "");
        assert!(flat("\n fix  it\nnow").starts_with(&first_line("\n fix  it\nnow")));
        assert!(d.belongs("w1", ""));
        assert!(d.belongs("w9", "dots"));
        assert!(!d.belongs("w9", "other"));
        assert!(!d.belongs("w9", ""));
    }
}
