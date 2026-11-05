//! The prompt box: `c` starts a coding agent in a new Herdr tab and hands it
//! the prompt, `r` sends it to the selected tab's agent, `n` runs it as a
//! shell command in a new tab. al stays where it is.
//!
//! The agent is `claude --dangerously-skip-permissions` (the `c` alias) unless
//! `$AL_AGENT` (else jv's `$JV_AGENT`) names another, e.g.
//! `AL_AGENT="codex --yolo"`: the first word is Herdr's agent kind, the rest
//! go to the agent.

use std::ffi::OsString;
use std::io::Write;
use std::ops::Range;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::Value;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

const DEFAULT_AGENT: &str = "claude --dangerously-skip-permissions";

/// Internal: `al --start-agent CWD PROMPT` does the Herdr calls. A separate
/// process, so quitting al right after Enter still gets the agent its prompt.
pub const CHILD_FLAG: &str = "--start-agent";
/// Internal: `al --run-command CWD COMMAND`, the same for `n`.
pub const RUN_FLAG: &str = "--run-command";

pub fn in_herdr() -> bool {
    std::env::var("HERDR_ENV").as_deref() == Ok("1")
}

/// Herdr's agent kind and the agent's own arguments.
pub fn spec() -> (String, Vec<String>) {
    let s = ["AL_AGENT", "JV_AGENT"].iter().find_map(|k| std::env::var(k).ok().filter(|s| !s.trim().is_empty()));
    let s = s.as_deref().unwrap_or(DEFAULT_AGENT);
    let mut words = s.split_whitespace().map(String::from);
    (words.next().unwrap_or_else(|| "claude".into()), words.collect())
}

/// Start the agent in the background. The outcome comes back on `tx` as a
/// status-bar line.
pub fn spawn(prompt: String, cwd: PathBuf, tx: mpsc::Sender<String>) {
    background(vec![CHILD_FLAG.into(), cwd.into(), prompt.into()], spec().0, tx);
}

/// `n`: run `command` in a new tab's shell, in the background, as `spawn`.
pub fn run(command: String, cwd: PathBuf, tx: mpsc::Sender<String>) {
    background(vec![RUN_FLAG.into(), cwd.into(), command.into()], "the command".into(), tx);
}

/// Run `al ARGS` (the internal child flag) in the background. Its one
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
                // Its own process group: nothing aimed at al's job reaches it.
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

/// The `--run-command` process, as `child`.
pub fn run_child(args: &[String]) -> ExitCode {
    let [cwd, command] = args else { return ExitCode::from(2) };
    report(run_in_tab(command, Path::new(cwd)))
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

/// A new tab in this workspace, in `cwd`, left in the background: its pane
/// and its label.
fn new_tab(cwd: &Path) -> Result<(String, String), String> {
    let ws = std::env::var("HERDR_WORKSPACE_ID").map_err(|_| "not in a Herdr pane (no HERDR_WORKSPACE_ID)".to_string())?;
    let cwd = cwd.to_string_lossy();
    let tab = herdr(&["tab", "create", "--workspace", &ws, "--cwd", &cwd, "--no-focus"])
        .map_err(|e| format!("couldn't open a tab: {e}"))?;
    let tab: Value = serde_json::from_str(&tab).map_err(|e| format!("tab create: {e}"))?;
    let pane = tab["result"]["root_pane"]["pane_id"].as_str().ok_or("tab create returned no pane")?.to_string();
    let label = tab["result"]["tab"]["label"].as_str().unwrap_or("").to_string();
    Ok((pane, label))
}

/// `n`: type `command` into a new tab's shell and press enter. The shell
/// holds it until its prompt is up, so there's nothing to wait for.
fn run_in_tab(command: &str, cwd: &Path) -> Result<String, String> {
    let (pane, label) = new_tab(cwd)?;
    herdr(&["pane", "run", &pane, command]).map_err(|e| format!("tab {label} is open, but the command didn't go: {e}"))?;
    Ok(format!("running in tab {label}"))
}

fn start(prompt: &str, cwd: &Path) -> Result<String, String> {
    let (kind, args) = spec();
    let (pane, label) = new_tab(cwd)?;
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

/// `r`: hand `prompt` to the agent running in `pane`. The outcome comes back
/// on `tx`. herdr runs as its own process group, so quitting al right after
/// Enter still gets the reply there.
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

/// Save the clipboard's image as a PNG under $TMPDIR/al. None when there's no image.
pub fn clipboard_image() -> Option<PathBuf> {
    let dir = std::env::temp_dir().join("al");
    std::fs::create_dir_all(&dir).ok()?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let path = dir.join(format!("paste-{}-{stamp}.png", std::process::id()));
    let quiet = |c: &mut Command| c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    // pngpaste answers in ~60ms; AppleScript takes about a second.
    let ok = if crate::herdr::which("pngpaste") {
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

/// A text field with a cursor (a byte offset into `text`): the agent box.
/// It edits as a multi-line text box does: ^a ^e (⌘← ⌘→ in Ghostty) and
/// Home End go to the ends of the cursor's line, ^u ^k delete to them, ⌘↑ ⌘↓
/// go to the ends of the whole text, and shift with a move (⌥⇧ for a word,
/// ⌥⇧↑↓ for the line) marks a selection that typing, a paste or ⌫ replaces.
#[derive(Default)]
pub struct Field {
    pub text: String,
    pub cur: usize,
    /// Where a selection started: it runs from here to `cur`.
    pub anchor: Option<usize>,
}

impl Field {
    /// The editing keys every input shares, readline's and macOS's. Returns
    /// true when the text changed; a move only moves the cursor.
    pub fn key(&mut self, k: &KeyEvent) -> bool {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let alt = k.modifiers.contains(KeyModifiers::ALT);
        let shift = k.modifiers.contains(KeyModifiers::SHIFT);
        let sup = k.modifiers.contains(KeyModifiers::SUPER);
        let before = self.text.clone();
        match k.code {
            // Word jumps: alt/ctrl+←→ arrive as modified arrows, or as ESC b /
            // ESC f (Ghostty's ⌥← ⌥→). With shift they select.
            KeyCode::Left if alt || ctrl => self.go(self.word_left_pos(), shift),
            KeyCode::Right if alt || ctrl => self.go(self.word_end(), shift),
            KeyCode::Char('b' | 'B') if alt => self.go(self.word_left_pos(), shift),
            KeyCode::Char('f' | 'F') if alt => self.go(self.word_end(), shift),
            // ⌘←→ (when the terminal sends them as such) and Home / End: the line's ends.
            KeyCode::Left if sup => self.go(self.line_start(self.cur), shift),
            KeyCode::Right if sup => self.go(self.line_end(self.cur), shift),
            KeyCode::Home if ctrl || sup => self.go(0, shift),
            KeyCode::End if ctrl || sup => self.go(self.text.len(), shift),
            KeyCode::Home => self.go(self.line_start(self.cur), shift),
            KeyCode::End => self.go(self.line_end(self.cur), shift),
            // ⌘↑ ⌘↓, as on macOS: the very start (end) of the text; ⇧⌘ selects to it.
            // Ghostty binds them to jump_to_prompt unless unbound (ghostty/config).
            KeyCode::Up if sup => self.go(0, shift),
            KeyCode::Down if sup => self.go(self.text.len(), shift),
            // ⌥↑ ⌥↓, as on macOS: to the start (end) of the line, then the one before (after).
            KeyCode::Up if alt => self.go(self.paragraph(-1), shift),
            KeyCode::Down if alt => self.go(self.paragraph(1), shift),
            KeyCode::Char('d' | 'D') if alt => self.kill_word_right(),
            KeyCode::Char('a' | 'A') if ctrl => self.go(self.line_start(self.cur), shift),
            KeyCode::Char('e' | 'E') if ctrl => self.go(self.line_end(self.cur), shift),
            KeyCode::Char('b') if ctrl => self.go(self.prev(), false),
            KeyCode::Char('f') if ctrl => self.go(self.next(), false),
            KeyCode::Char('d') if ctrl => self.delete(),
            KeyCode::Char('u') if ctrl => self.kill_start(),
            KeyCode::Char('k') if ctrl => self.kill_end(),
            KeyCode::Char('w') if ctrl => self.kill_word(),
            KeyCode::Char('l') if ctrl => self.clear(),
            KeyCode::Backspace if alt => self.kill_word(),
            // ← → with a selection and no shift: to its edge, as a text box does.
            KeyCode::Left if !shift && self.selection().is_some() => self.go(self.selection().map_or(self.cur, |r| r.start), false),
            KeyCode::Right if !shift && self.selection().is_some() => self.go(self.selection().map_or(self.cur, |r| r.end), false),
            KeyCode::Left => self.go(self.prev(), shift),
            KeyCode::Right => self.go(self.next(), shift),
            KeyCode::Backspace => self.backspace(),
            KeyCode::Delete => self.delete(),
            KeyCode::Char(c) if !ctrl => self.insert(c.encode_utf8(&mut [0; 4])),
            _ => {}
        }
        self.text != before
    }

    /// The selected bytes, when there are any.
    pub fn selection(&self) -> Option<Range<usize>> {
        let a = self.anchor?.min(self.text.len());
        (a != self.cur).then(|| a.min(self.cur)..a.max(self.cur))
    }

    pub fn selected(&self) -> Option<&str> {
        self.selection().map(|r| &self.text[r])
    }

    /// Take the selection out of the text. False when there was none.
    pub fn delete_selection(&mut self) -> bool {
        let sel = self.selection();
        self.anchor = None;
        let Some(r) = sel else { return false };
        self.text.replace_range(r.clone(), "");
        self.cur = r.start;
        true
    }

    /// The cursor to `to`; `extend` (shift) carries the selection along,
    /// starting one where the cursor was, and without it the selection goes.
    fn go(&mut self, to: usize, extend: bool) {
        if extend {
            self.anchor.get_or_insert(self.cur);
        } else {
            self.anchor = None;
        }
        self.cur = to;
    }

    /// Where the line holding byte `i` starts.
    fn line_start(&self, i: usize) -> usize {
        self.text[..i].rfind('\n').map_or(0, |p| p + 1)
    }

    /// Where the line holding byte `i` ends (its `\n`, or the text's end).
    fn line_end(&self, i: usize) -> usize {
        self.text[i..].find('\n').map_or(self.text.len(), |p| i + p)
    }

    /// ⌥↑ / ⌥↓: the line's start (end), or the previous line's start (the
    /// next one's end) when the cursor is already there.
    fn paragraph(&self, dir: isize) -> usize {
        if dir < 0 {
            let s = self.line_start(self.cur);
            if s < self.cur || s == 0 {
                s
            } else {
                self.line_start(s - 1)
            }
        } else {
            let e = self.line_end(self.cur);
            if e > self.cur || e == self.text.len() {
                e
            } else {
                self.line_end(e + 1)
            }
        }
    }

    /// ^l, and ^c in the box: everything.
    pub fn clear(&mut self) {
        self.text.clear();
        self.cur = 0;
        self.anchor = None;
    }

    /// ↑ / ↓ in the wrapped, multi-line agent box: the same column on the
    /// screen row `dir` away (`rows` as the box draws them); up from the
    /// first row goes to the start, down from the last to the end. With
    /// `extend` (⇧↑ ⇧↓) the selection comes along.
    pub fn vertical_by(&mut self, rows: &[Range<usize>], dir: isize, extend: bool) {
        let to = self.row_target(rows, dir);
        self.go(to, extend);
    }

    fn row_target(&self, rows: &[Range<usize>], dir: isize) -> usize {
        let Some(cr) = rows.iter().rposition(|r| r.start <= self.cur) else { return self.cur };
        let col = self.text[rows[cr].start..self.cur].width();
        match cr.checked_add_signed(dir).filter(|&i| i < rows.len()) {
            Some(to) => self.pos_at(rows, to, col),
            None if dir < 0 => 0,
            None => self.text.len(),
        }
    }

    /// The place at screen column `col` of row `row` (`rows` as drawn): on
    /// the character in that cell, the row's end past its text, the text's
    /// end below its last row. A click, and ↑↓ keeping their column.
    pub fn pos_at(&self, rows: &[Range<usize>], row: usize, col: usize) -> usize {
        let Some(r) = rows.get(row).cloned() else { return self.text.len() };
        // A row wrapped mid-line ends where the next one starts, and a cursor
        // there draws on the next row: stop a character short of it.
        let wrapped = rows.get(row + 1).is_some_and(|n| n.start == r.end);
        let (mut at, mut w) = (r.start, 0);
        for (i, c) in self.text[r.clone()].char_indices() {
            let end = r.start + i + c.len_utf8();
            w += c.width().unwrap_or(0);
            if w > col || (wrapped && end == r.end) {
                break;
            }
            at = end;
        }
        // Never inside an `[Image #N]` tag.
        image_tags(&self.text).into_iter().find(|(t, _)| t.start < at && at < t.end).map_or(at, |(t, _)| t.start)
    }

    /// What a double-click at `at` takes: the word there by Unicode's word
    /// bounds (a run of spaces or of punctuation is one too), the one ending
    /// there at a line's end; an `[Image #N]` tag whole.
    pub fn word_at(&self, at: usize) -> Range<usize> {
        if let Some((t, _)) = image_tags(&self.text).into_iter().find(|(t, _)| t.start <= at && at < t.end) {
            return t;
        }
        let (s, e) = (self.line_start(at), self.line_end(at));
        let words = || self.text[s..e].split_word_bound_indices().map(|(b, w)| s + b..s + b + w.len());
        words().find(|r| r.contains(&at)).or_else(|| words().last().filter(|r| r.end == at)).unwrap_or(at..at)
    }

    /// What a triple-click at `at` takes: its line, without the line break.
    pub fn line_at(&self, at: usize) -> Range<usize> {
        self.line_start(at)..self.line_end(at)
    }

    /// Select `r`, the cursor at its end; an empty one is just the cursor.
    pub fn select(&mut self, r: Range<usize>) {
        self.anchor = (r.start != r.end).then_some(r.start);
        self.cur = r.end;
    }

    /// A selection from `anchor` to `cur`, the cursor at `cur`.
    pub fn select_from(&mut self, anchor: usize, cur: usize) {
        self.anchor = Some(anchor);
        self.cur = cur;
    }

    /// Type `s`, over the selection if there is one.
    pub fn insert(&mut self, s: &str) {
        self.delete_selection();
        self.text.insert_str(self.cur, s);
        self.cur += s.len();
    }

    /// `word` as a word of its own: a space before it when the cursor sits
    /// right after text, and one after it. Over the selection, as `insert`.
    pub fn insert_word(&mut self, word: &str) {
        self.delete_selection();
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

    /// The very end of the text.
    pub fn end(&mut self) {
        self.go(self.text.len(), false);
    }

    /// The selection, or the character before the cursor; an `[Image #N]`
    /// tag goes in one keystroke, like a single character.
    pub fn backspace(&mut self) {
        if self.delete_selection() {
            return;
        }
        let tag = image_tags(&self.text).into_iter().find(|(r, _)| r.end == self.cur);
        let p = tag.map_or_else(|| self.prev(), |(r, _)| r.start);
        self.text.replace_range(p..self.cur, "");
        self.cur = p;
    }

    pub fn delete(&mut self) {
        if self.delete_selection() {
            return;
        }
        let tag = image_tags(&self.text).into_iter().find(|(r, _)| r.start == self.cur);
        let n = tag.map_or_else(|| self.next(), |(r, _)| r.end);
        self.text.replace_range(self.cur..n, "");
    }

    /// alt-←: back to the start of this word (or the previous one).
    fn word_left_pos(&self) -> usize {
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
        image_tags(&self.text).into_iter().find(|(r, _)| r.start < pos && pos < r.end).map_or(pos, |(r, _)| r.start)
    }

    /// alt-→: on to the end of this word (or the next one).
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

    /// alt-d: from the cursor to the end of the word (or the selection).
    pub fn kill_word_right(&mut self) {
        if self.delete_selection() {
            return;
        }
        let e = self.word_end();
        self.text.replace_range(self.cur..e, "");
    }

    /// ^w: the word before the cursor, with the spaces after it (or the selection).
    pub fn kill_word(&mut self) {
        if self.delete_selection() {
            return;
        }
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

    /// ^u (⌘⌫ in Ghostty): back to the start of the cursor's line; at its
    /// start, the line break before it, joining the line above.
    pub fn kill_start(&mut self) {
        if self.delete_selection() {
            return;
        }
        let s = self.line_start(self.cur);
        let s = if s == self.cur { s.saturating_sub(1) } else { s };
        self.text.replace_range(s..self.cur, "");
        self.cur = s;
    }

    /// ^k: on to the end of the cursor's line; at its end, the line break,
    /// joining the line below (emacs's ^k).
    pub fn kill_end(&mut self) {
        if self.delete_selection() {
            return;
        }
        let e = self.line_end(self.cur);
        let e = if e == self.cur && e < self.text.len() { e + 1 } else { e };
        self.text.replace_range(self.cur..e, "");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(text: &str, cur: usize) -> Field {
        Field { text: text.into(), cur, ..Default::default() }
    }

    fn press(f: &mut Field, code: KeyCode, mods: KeyModifiers) {
        f.key(&KeyEvent::new(code, mods));
    }

    const CTRL: KeyModifiers = KeyModifiers::CONTROL;
    const SHIFT: KeyModifiers = KeyModifiers::SHIFT;
    const ALT_SHIFT: KeyModifiers = KeyModifiers::ALT.union(KeyModifiers::SHIFT);

    #[test]
    fn ctrl_a_and_e_stay_on_the_line() {
        let mut f = field("one\ntwo three\nfour", 8);
        press(&mut f, KeyCode::Char('a'), CTRL);
        assert_eq!(f.cur, 4);
        press(&mut f, KeyCode::Char('e'), CTRL);
        assert_eq!(f.cur, 13);
        press(&mut f, KeyCode::Home, KeyModifiers::NONE);
        assert_eq!(f.cur, 4);
        press(&mut f, KeyCode::End, KeyModifiers::NONE);
        assert_eq!(f.cur, 13);
    }

    #[test]
    fn ctrl_u_and_k_stay_on_the_line_then_join() {
        let mut f = field("one\ntwo three\nfour", 8);
        press(&mut f, KeyCode::Char('u'), CTRL);
        assert_eq!((f.text.as_str(), f.cur), ("one\nthree\nfour", 4));
        press(&mut f, KeyCode::Char('u'), CTRL);
        assert_eq!((f.text.as_str(), f.cur), ("onethree\nfour", 3));
        let mut f = field("one\ntwo three\nfour", 8);
        press(&mut f, KeyCode::Char('k'), CTRL);
        assert_eq!(f.text, "one\ntwo \nfour");
        press(&mut f, KeyCode::Char('k'), CTRL);
        assert_eq!(f.text, "one\ntwo four");
    }

    #[test]
    fn shift_and_alt_shift_arrows_select() {
        let mut f = field("hello brave world", 6);
        press(&mut f, KeyCode::Right, ALT_SHIFT);
        assert_eq!(f.selected(), Some("brave"));
        press(&mut f, KeyCode::Right, SHIFT);
        assert_eq!(f.selected(), Some("brave "));
        press(&mut f, KeyCode::Left, ALT_SHIFT);
        assert_eq!(f.selected(), None);
        press(&mut f, KeyCode::Left, ALT_SHIFT);
        assert_eq!(f.selected(), Some("hello "));
        // Typing replaces it; ← without shift would have gone to its start.
        press(&mut f, KeyCode::Char('X'), SHIFT);
        assert_eq!((f.text.as_str(), f.cur, f.selection()), ("Xbrave world", 1, None));
    }

    #[test]
    fn alt_shift_up_down_select_to_the_line_ends() {
        let mut f = field("one\ntwo three\nfour", 8);
        press(&mut f, KeyCode::Down, ALT_SHIFT);
        assert_eq!(f.selected(), Some("three"));
        press(&mut f, KeyCode::Down, ALT_SHIFT);
        assert_eq!(f.selected(), Some("three\nfour"));
        let mut f = field("one\ntwo three\nfour", 8);
        press(&mut f, KeyCode::Up, ALT_SHIFT);
        assert_eq!(f.selected(), Some("two "));
        press(&mut f, KeyCode::Up, ALT_SHIFT);
        assert_eq!(f.selected(), Some("one\ntwo "));
    }

    #[test]
    fn cmd_up_down_go_to_the_text_ends() {
        let mut f = field("one\ntwo three\nfour", 8);
        press(&mut f, KeyCode::Up, KeyModifiers::SUPER);
        assert_eq!((f.cur, f.selection()), (0, None));
        press(&mut f, KeyCode::Down, KeyModifiers::SUPER);
        assert_eq!((f.cur, f.selection()), (18, None));
        let mut f = field("one\ntwo three\nfour", 8);
        press(&mut f, KeyCode::Down, KeyModifiers::SUPER.union(SHIFT));
        assert_eq!(f.selected(), Some("three\nfour"));
        press(&mut f, KeyCode::Up, KeyModifiers::SUPER.union(SHIFT));
        assert_eq!(f.selected(), Some("one\ntwo "));
    }

    #[test]
    fn a_selection_goes_on_backspace_and_arrows_collapse_it() {
        let mut f = field("abc def", 7);
        press(&mut f, KeyCode::Char('a'), CTRL.union(SHIFT));
        assert_eq!(f.selected(), Some("abc def"));
        press(&mut f, KeyCode::Left, KeyModifiers::NONE);
        assert_eq!((f.cur, f.selection()), (0, None));
        press(&mut f, KeyCode::Right, SHIFT);
        press(&mut f, KeyCode::Right, SHIFT);
        press(&mut f, KeyCode::Backspace, KeyModifiers::NONE);
        assert_eq!((f.text.as_str(), f.cur), ("c def", 0));
    }

    #[test]
    fn a_click_lands_on_its_cell() {
        // "hello brave " wraps after its space; the cursor never sits past it.
        let f = field("hello brave world\nnext", 0);
        let rows = [0..12, 12..17, 18..22];
        assert_eq!(f.pos_at(&rows, 0, 1), 1);
        assert_eq!(f.pos_at(&rows, 0, 40), 11);
        assert_eq!(f.pos_at(&rows, 1, 40), 17);
        assert_eq!(f.pos_at(&rows, 2, 2), 20);
        assert_eq!(f.pos_at(&rows, 9, 0), 22);
        // Not inside an image tag.
        let f = field("see [Image #1] here", 0);
        assert_eq!(f.pos_at(&[0..19], 0, 8), 4);
    }

    #[test]
    fn double_and_triple_click_take_a_word_and_a_line() {
        let f = field("one two-three\n[Image #2] four", 0);
        assert_eq!(&f.text[f.word_at(5)], "two");
        assert_eq!(&f.text[f.word_at(3)], " ");
        assert_eq!(&f.text[f.word_at(13)], "three");
        assert_eq!(&f.text[f.word_at(17)], "[Image #2]");
        assert_eq!(&f.text[f.line_at(5)], "one two-three");
        assert_eq!(&f.text[f.line_at(26)], "[Image #2] four");
    }

    #[test]
    fn shift_down_selects_by_row() {
        let mut f = field("abcd\nefgh", 1);
        let rows = [0..4, 5..9];
        f.vertical_by(&rows, 1, true);
        assert_eq!(f.selected(), Some("bcd\ne"));
        f.vertical_by(&rows, -1, false);
        assert_eq!((f.cur, f.selection()), (1, None));
    }
}
