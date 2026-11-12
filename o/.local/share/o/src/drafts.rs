//! Drafts: prompts kept for later (^s), gone through with ^g. o's own (oc's
//! and al's are Herdr's, in al's file):
//!
//!   $XDG_STATE_HOME/o/drafts.json        (else ~/.local/state/o)
//!   $XDG_STATE_HOME/o/drafts/<id>/N.png  the file behind `[Image #N]`
//!
//! A draft belongs to the Rex session it was written in. The file is read
//! fresh before each write and written whole (to a temp file, then renamed),
//! so two o's don't lose each other's drafts. The format is al's, so the
//! code is oc's (al's drafts.rs, less the pictures).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// The agent a reply goes to: its block, the tab it was in and what that
/// tab was called, and its session.
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
    /// The Rex session it was written in: its id, and its name (a new
    /// session with the same name gets them too).
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
    /// Its configuration, by name (`claude(fable)`; config.rs). Without
    /// it: without it, the first configuration of `kind`.
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

/// o's state folder.
fn state_dir() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME").filter(|s| !s.is_empty()).map(PathBuf::from);
    base.unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/state")).join("o")
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
/// first, so another o's drafts aren't lost.
pub fn put(d: &Draft) -> Result<(), String> {
    let mut all = load();
    match all.iter_mut().find(|x| x.id == d.id) {
        Some(x) => *x = d.clone(),
        None => all.insert(0, d.clone()),
    }
    store(&all)
}

/// Take drafts `ids` out, in one write. Their images stay a while (`sweep`
/// takes the folders after three days): `u` brings a deleted draft back,
/// and a draft's agent reads them after it runs.
pub fn remove(ids: &[&str]) -> Result<(), String> {
    let mut all = load();
    all.retain(|d| !ids.contains(&d.id.as_str()));
    store(&all)?;
    // Folders written to now: a sweep would count their days from here.
    for id in ids {
        let _ = std::fs::write(image_dir(id).join(".left"), "");
    }
    Ok(())
}

/// The images `text` still tags, by number: `(N, file)` for `[Image #N]`.
pub fn tagged(text: &str, images: &[PathBuf]) -> Vec<(usize, PathBuf)> {
    let mut nums: Vec<usize> = crate::field::image_tags(text).into_iter().map(|(_, n)| n).collect();
    nums.sort_unstable();
    nums.dedup();
    nums.into_iter().filter_map(|n| Some((n, images.get(n.checked_sub(1)?)?.clone()))).collect()
}

// ---- several as one ----------------------------------------------------------

/// What goes before the tasks when marked drafts go as one prompt ({n}: how
/// many there are).
const PREAMBLE: &str = "\
Here are {n} tasks, drafted one at a time and sent together. Do all of them in this session.

- Read every task before starting. Where two touch the same code, or one depends on another, plan them together and pick the order; otherwise go in the order given.
- Treat each as its own piece of work: finish it and check it before moving to the next.
- Don't stop between tasks to ask. If one is blocked or unclear, make the reasonable call (or skip it and say why) and keep going.
- Finish with a short report, a few lines per task: what changed and where, how you checked it, and anything left open.";

/// Said too when a task was written in another folder than the first's,
/// where the agent starts.
const ELSEWHERE: &str = "- A task written in another folder names it in its heading: do that one there.";

/// Drafts `ds` as one prompt, for one agent started in the first one's
/// folder: the preamble, then each as `## Task i of n`. Their `[Image #N]`
/// tags are numbered again across all of them; the files come back in that
/// order (a tag with no file reads `[missing image]`).
pub fn combine(ds: &[Draft]) -> (String, Vec<PathBuf>) {
    let Some(first) = ds.first() else { return (String::new(), Vec::new()) };
    let mut images = Vec::new();
    let mut out = PREAMBLE.replace("{n}", &ds.len().to_string());
    if ds.iter().any(|d| d.cwd != first.cwd) {
        out.push('\n');
        out.push_str(ELSEWHERE);
    }
    for (i, d) in ds.iter().enumerate() {
        out.push_str(&format!("\n\n## Task {} of {}", i + 1, ds.len()));
        if d.cwd != first.cwd {
            out.push_str(&format!(" (in {})", tilde(&d.cwd)));
        }
        out.push_str("\n\n");
        out.push_str(&renumber(d.text.trim(), &d.images, &mut images));
    }
    (out, images)
}

/// `text` with each `[Image #N]` (the Nth of `own`) numbered as it lands in
/// `all`, which it's added to.
fn renumber(text: &str, own: &[PathBuf], all: &mut Vec<PathBuf>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut seen: Vec<(usize, usize)> = Vec::new();
    let mut at = 0;
    for (r, n) in crate::field::image_tags(text) {
        out.push_str(&text[at..r.start]);
        let to = seen.iter().find(|(from, _)| *from == n).map(|&(_, to)| to).or_else(|| {
            let file = own.get(n.checked_sub(1)?)?;
            all.push(file.clone());
            seen.push((n, all.len()));
            Some(all.len())
        });
        match to {
            Some(m) => out.push_str(&format!("[Image #{m}]")),
            None => out.push_str("[missing image]"),
        }
        at = r.end;
    }
    out.push_str(&text[at..]);
    out
}

/// How a combined send is echoed: how many, then each one's first line.
pub fn summary(ds: &[Draft]) -> String {
    let mut s = format!("{} drafts as one prompt", ds.len());
    for (i, d) in ds.iter().enumerate() {
        s.push_str(&format!("\n{}. {}", i + 1, crate::field::first_line(&d.text)));
    }
    s
}

/// `path` with the home folder as `~`.
fn tilde(path: &Path) -> String {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    match home.as_deref().and_then(|h| path.strip_prefix(h).ok()) {
        Some(rest) if rest.as_os_str().is_empty() => "~".into(),
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

/// A new draft's id: the time and this o's count, in base 36.
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

/// Delete image folders no draft has used for three days (al's). In a
/// thread, at start.
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

    fn draft(cwd: &str, text: &str, images: &[&str]) -> Draft {
        Draft {
            id: text.into(),
            workspace: "w1".into(),
            space: String::new(),
            cwd: cwd.into(),
            text: text.into(),
            images: images.iter().map(PathBuf::from).collect(),
            created: 1,
            reply: None,
            kind: None,
            config: None,
            plan: false,
        }
    }

    #[test]
    fn combines_drafts_numbering_their_images_across_them() {
        let a = draft("/r", "fix [Image #2] and [Image #1]\n", &["/a1.png", "/a2.png"]);
        let b = draft("/r", "see [Image #1], again [Image #1], and [Image #3]", &["/b1.png"]);
        let (text, images) = combine(&[a.clone(), b]);
        assert!(text.starts_with("Here are 2 tasks"));
        assert!(!text.contains(ELSEWHERE));
        assert!(text.ends_with("## Task 1 of 2\n\nfix [Image #1] and [Image #2]\n\n## Task 2 of 2\n\nsee [Image #3], again [Image #3], and [missing image]"));
        assert_eq!(images, [PathBuf::from("/a2.png"), "/a1.png".into(), "/b1.png".into()]);
        // Another folder: said in the task's heading.
        let c = draft("/elsewhere", "and this", &[]);
        let (text, _) = combine(&[a, c]);
        assert!(text.contains(ELSEWHERE) && text.contains("## Task 2 of 2 (in /elsewhere)\n\nand this"));
    }

    #[test]
    fn tagged_lists_the_images_still_in_the_text() {
        let imgs = [PathBuf::from("/1.png"), "/2.png".into(), "/3.png".into()];
        assert_eq!(tagged("[Image #3] then [Image #1] [Image #3] [Image #9]", &imgs), [(1, PathBuf::from("/1.png")), (3, "/3.png".into())]);
    }
}
