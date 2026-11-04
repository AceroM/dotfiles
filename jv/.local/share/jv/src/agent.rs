//! `c`: a prompt box that starts a coding agent in a new Herdr tab, in the
//! repo jv is showing, and hands it the prompt. jv stays where it is.
//!
//! The agent is `claude --dangerously-skip-permissions` (the `c` alias) unless
//! `$JV_AGENT` names another, e.g. `JV_AGENT="codex --yolo"`: the first word
//! is Herdr's agent kind, the rest go to the agent.

use std::ffi::OsString;
use std::io::Write;
use std::ops::Range;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde_json::Value;

const DEFAULT_AGENT: &str = "claude --dangerously-skip-permissions";

/// Internal: `jv --start-agent CWD PROMPT` does the Herdr calls. A separate
/// process, so quitting jv right after Enter still gets the agent its prompt.
pub const CHILD_FLAG: &str = "--start-agent";

pub fn in_herdr() -> bool {
    std::env::var("HERDR_ENV").as_deref() == Ok("1")
}

/// Herdr's agent kind and the agent's own arguments.
pub fn spec() -> (String, Vec<String>) {
    let s = std::env::var("JV_AGENT").ok().filter(|s| !s.trim().is_empty());
    let s = s.as_deref().unwrap_or(DEFAULT_AGENT);
    let mut words = s.split_whitespace().map(String::from);
    (words.next().unwrap_or_else(|| "claude".into()), words.collect())
}

/// Start the agent in the background. The outcome comes back on `tx` as a
/// status-bar line.
pub fn spawn(prompt: String, cwd: PathBuf, tx: mpsc::Sender<String>) {
    background(vec![CHILD_FLAG.into(), cwd.into(), prompt.into()], spec().0, tx);
}

/// Run `jv ARGS` (one of the internal child flags) in the background. Its one
/// stdout line comes back on `tx` as a status-bar line; `what` names the job
/// when it can't start.
pub fn background(args: Vec<OsString>, what: String, tx: mpsc::Sender<String>) {
    thread::spawn(move || {
        let child = std::env::current_exe().and_then(|exe| {
            Command::new(exe)
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                // Its own process group: nothing aimed at jv's job reaches it.
                .process_group(0)
                .spawn()
        });
        let msg = match child.and_then(|c| c.wait_with_output()) {
            Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
            Err(e) => format!("couldn't start {what}: {e}"),
        };
        let _ = tx.send(if msg.is_empty() { format!("{what} didn't start") } else { msg });
    });
}

/// The `--start-agent` process: one line on stdout says how it went.
pub fn child(args: &[String]) -> ExitCode {
    let [cwd, prompt] = args else { return ExitCode::from(2) };
    report(start(prompt, Path::new(cwd)))
}

/// A child process's ending: its outcome as the one stdout line `background`
/// hands back.
pub fn report(res: Result<String, String>) -> ExitCode {
    let _ = writeln!(std::io::stdout(), "{}", res.as_ref().unwrap_or_else(|e| e));
    if res.is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn start(prompt: &str, cwd: &Path) -> Result<String, String> {
    let (kind, args) = spec();
    let ws = std::env::var("HERDR_WORKSPACE_ID").map_err(|_| "not in a Herdr pane (no HERDR_WORKSPACE_ID)".to_string())?;
    let cwd = cwd.to_string_lossy();
    let tab = herdr(&["tab", "create", "--workspace", &ws, "--cwd", &cwd, "--no-focus"])
        .map_err(|e| format!("couldn't open a tab: {e}"))?;
    let tab: Value = serde_json::from_str(&tab).map_err(|e| format!("tab create: {e}"))?;
    let pane = tab["result"]["root_pane"]["pane_id"].as_str().ok_or("tab create returned no pane")?.to_string();
    let label = tab["result"]["tab"]["label"].as_str().unwrap_or("").to_string();
    // Agent names are [a-z][a-z0-9_-]{0,31}; pane IDs are unique, and their
    // only uppercase is base-36 digits, so lowercasing keeps them unique.
    let name = format!("{kind}-{}", pane.to_ascii_lowercase().replace(':', "-"));
    let mut cmd = vec!["agent", "start", &name, "--kind", &kind, "--pane", &pane];
    if !args.is_empty() {
        cmd.push("--");
        cmd.extend(args.iter().map(String::as_str));
    }
    // The new tab's shell is still sourcing its rc files for a few hundred ms,
    // and until it's at a prompt Herdr answers agent_pane_busy.
    let mut tries = 0;
    loop {
        match herdr(&cmd) {
            Ok(_) => break,
            Err(e) if e.contains("agent_pane_busy") && tries < 50 => {
                tries += 1;
                thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("{kind} didn't start in tab {label}: {e}")),
        }
    }
    // No `--` here: Herdr would read a prompt starting with - as an option.
    herdr(&["agent", "prompt", &name, prompt]).map_err(|e| format!("{kind} is up in tab {label}, but the prompt failed: {e}"))?;
    Ok(format!("{kind} is on it in tab {label}"))
}

/// `r` in the `;` dialog: hand `prompt` to the agent running in `pane`. The
/// outcome comes back on `tx`. herdr runs as its own process group, so
/// quitting jv right after Enter still gets the reply there.
pub fn reply(pane: String, prompt: String, label: String, tx: mpsc::Sender<String>) {
    thread::spawn(move || {
        // No `--`: herdr takes a prompt starting with - as the prompt, and `--` as an option.
        let out = Command::new("herdr")
            .args(["agent", "prompt", &pane, &prompt])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .output();
        let msg = match out {
            Ok(o) if o.status.success() => format!("sent to {label}"),
            Ok(o) => format!("couldn't reply to {label}: {}", failure(&o)),
            Err(e) => format!("couldn't reply to {label}: herdr: {e}"),
        };
        let _ = tx.send(msg);
    });
}

/// Run `herdr ARGS`: stdout on success, else the error's message.
pub fn herdr(args: &[&str]) -> Result<String, String> {
    let out = Command::new("herdr")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("herdr: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    Err(failure(&out))
}

/// A failed herdr call's error message.
fn failure(out: &Output) -> String {
    let stdout = String::from_utf8_lossy(&out.stdout);
    // Errors are JSON on stdout or stderr: {"error":{"code":…,"message":…}}.
    let all = format!("{stdout}{}", String::from_utf8_lossy(&out.stderr));
    let err = all.lines().find_map(|l| serde_json::from_str::<Value>(l).ok()).map(|v| v["error"].clone());
    let field = |k: &str| err.as_ref().and_then(|e| e[k].as_str()).unwrap_or("").to_string();
    let (code, msg) = (field("code"), field("message"));
    let msg = if msg.is_empty() { all.trim().lines().next().unwrap_or("").to_string() } else { msg };
    // Keep the code in the text: callers match on it (agent_pane_busy).
    if code.is_empty() || msg.contains(&code) {
        msg
    } else {
        format!("{msg} ({code})")
    }
}

// ---- images ---------------------------------------------------------------
//
// Like Claude Code: an image pasted (^v) or dropped into the box shows as an
// `[Image #N]` tag. The prompt keeps the tags and lists each one's file at the
// end, and the agent opens them with its own file tools.

const IMAGE_EXT: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

/// Save the clipboard's image as a PNG under $TMPDIR/jv. None when there's no image.
pub fn clipboard_image() -> Option<PathBuf> {
    let dir = std::env::temp_dir().join("jv");
    std::fs::create_dir_all(&dir).ok()?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let path = dir.join(format!("paste-{}-{stamp}.png", std::process::id()));
    let quiet = |c: &mut Command| c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    // pngpaste answers in ~60ms; AppleScript takes about a second.
    let ok = if crate::source::which("pngpaste") {
        quiet(Command::new("pngpaste").arg(&path)).is_ok_and(|s| s.success())
    } else {
        let script = [
            "on run argv",
            "try",
            "set img to the clipboard as «class PNGf»",
            "on error",
            "error number 1",
            "end try",
            "set f to open for access (POSIX file (item 1 of argv)) with write permission",
            "set eof f to 0",
            "write img to f",
            "close access f",
            "end run",
        ];
        let mut c = Command::new("osascript");
        for line in script {
            c.args(["-e", line]);
        }
        quiet(c.arg(&path)).is_ok_and(|s| s.success())
    };
    if ok && std::fs::metadata(&path).is_ok_and(|m| m.len() > 0) {
        Some(path)
    } else {
        let _ = std::fs::remove_file(&path);
        None
    }
}

/// A paste that's nothing but image files (a drag from Finder pastes their
/// shell-escaped paths): those files.
pub fn image_paths(s: &str) -> Option<Vec<PathBuf>> {
    let words = shell_words(s.trim());
    if words.is_empty() {
        return None;
    }
    words
        .into_iter()
        .map(|w| {
            let p = PathBuf::from(w.strip_prefix("file://").unwrap_or(&w));
            let ext = p.extension()?.to_str()?.to_ascii_lowercase();
            (IMAGE_EXT.contains(&ext.as_str()) && p.is_file()).then_some(p)
        })
        .collect()
}

/// Split on unescaped whitespace, honoring `\` escapes and quotes.
fn shell_words(s: &str) -> Vec<String> {
    let (mut out, mut cur, mut quote) = (Vec::new(), String::new(), None);
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match (c, quote) {
            ('\\', q) if q != Some('\'') => cur.extend(chars.next()),
            ('\'' | '"', None) => quote = Some(c),
            (c, Some(q)) if c == q => quote = None,
            (c, None) if c.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            (c, _) => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// `[Image #N]` tags in `text`: their byte ranges and numbers.
pub fn image_tags(text: &str) -> Vec<(Range<usize>, usize)> {
    const OPEN: &str = "[Image #";
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(p) = text[i..].find(OPEN) {
        let s = i + p;
        let rest = &text[s + OPEN.len()..];
        let d = rest.bytes().take_while(u8::is_ascii_digit).count();
        i = s + OPEN.len();
        if d > 0 && rest.as_bytes().get(d) == Some(&b']') {
            let end = i + d + 1;
            out.push((s..end, rest[..d].parse().unwrap_or(0)));
            i = end;
        }
    }
    out
}

/// The prompt as sent: the text, then the file behind each tag it still has.
pub fn with_images(text: &str, images: &[PathBuf]) -> String {
    let mut nums: Vec<usize> = image_tags(text).into_iter().map(|(_, n)| n).collect();
    nums.sort_unstable();
    nums.dedup();
    let files: Vec<String> = nums
        .into_iter()
        .filter_map(|n| Some(format!("[Image #{n}]: {}", images.get(n.checked_sub(1)?)?.display())))
        .collect();
    if files.is_empty() {
        text.to_string()
    } else {
        format!("{text}\n\n{}", files.join("\n"))
    }
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// A text field with a cursor (a byte offset into `text`).
#[derive(Default)]
pub struct Field {
    pub text: String,
    pub cur: usize,
}

impl Field {
    pub fn insert(&mut self, s: &str) {
        self.text.insert_str(self.cur, s);
        self.cur += s.len();
    }

    /// `word` as a word of its own: a space before it when the cursor sits
    /// right after text, and one after it.
    pub fn insert_word(&mut self, word: &str) {
        let before = self.text[..self.cur].chars().next_back().is_some_and(|c| !c.is_whitespace());
        let after = self.text[self.cur..].starts_with(' ');
        self.insert(&format!("{}{word}{}", if before { " " } else { "" }, if after { "" } else { " " }));
    }

    fn prev(&self) -> usize {
        self.text[..self.cur].char_indices().next_back().map_or(0, |(i, _)| i)
    }

    fn next(&self) -> usize {
        self.text[self.cur..].chars().next().map_or(self.cur, |c| self.cur + c.len_utf8())
    }

    pub fn left(&mut self) {
        self.cur = self.prev();
    }

    pub fn right(&mut self) {
        self.cur = self.next();
    }

    pub fn home(&mut self) {
        self.cur = 0;
    }

    pub fn end(&mut self) {
        self.cur = self.text.len();
    }

    /// An `[Image #N]` tag goes in one keystroke, like a single character.
    pub fn backspace(&mut self) {
        let tag = image_tags(&self.text).into_iter().find(|(r, _)| r.end == self.cur);
        let p = tag.map_or_else(|| self.prev(), |(r, _)| r.start);
        self.text.replace_range(p..self.cur, "");
        self.cur = p;
    }

    pub fn delete(&mut self) {
        let tag = image_tags(&self.text).into_iter().find(|(r, _)| r.start == self.cur);
        let n = tag.map_or_else(|| self.next(), |(r, _)| r.end);
        self.text.replace_range(self.cur..n, "");
    }

    /// alt-←: back to the start of this word (or the previous one).
    pub fn word_left(&mut self) {
        let mut it = self.text[..self.cur].char_indices().rev().peekable();
        let mut pos = self.cur;
        for word in [false, true] {
            while let Some(&(i, c)) = it.peek() {
                if is_word(c) != word {
                    break;
                }
                pos = i;
                it.next();
            }
        }
        // An `[Image #N]` tag is one word.
        self.cur = image_tags(&self.text).into_iter().find(|(r, _)| r.start < pos && pos < r.end).map_or(pos, |(r, _)| r.start);
    }

    /// alt-→: on to the end of this word (or the next one).
    pub fn word_right(&mut self) {
        self.cur = self.word_end();
    }

    fn word_end(&self) -> usize {
        let end = self.word_end_raw();
        image_tags(&self.text).into_iter().find(|(r, _)| r.start < end && end < r.end).map_or(end, |(r, _)| r.end)
    }

    fn word_end_raw(&self) -> usize {
        let mut it = self.text[self.cur..].char_indices().peekable();
        let mut end = 0;
        for word in [false, true] {
            while let Some(&(i, c)) = it.peek() {
                if is_word(c) != word {
                    break;
                }
                end = i + c.len_utf8();
                it.next();
            }
        }
        self.cur + end
    }

    /// alt-d: from the cursor to the end of the word.
    pub fn kill_word_right(&mut self) {
        let e = self.word_end();
        self.text.replace_range(self.cur..e, "");
    }

    /// ^w: the word before the cursor, with the spaces after it.
    pub fn kill_word(&mut self) {
        let before = &self.text[..self.cur];
        let t = before.trim_end().len();
        let cut = before[..t]
            .char_indices()
            .rev()
            .find(|&(_, c)| c.is_whitespace() || c == '/')
            .map_or(0, |(i, c)| i + c.len_utf8());
        self.text.replace_range(cut..self.cur, "");
        self.cur = cut;
    }

    /// ^u
    pub fn kill_start(&mut self) {
        self.text.replace_range(..self.cur, "");
        self.cur = 0;
    }

    /// ^k
    pub fn kill_end(&mut self) {
        self.text.truncate(self.cur);
    }
}
