//! Rex, through its `rex` CLI. A Rex session is the space al lists, a window
//! is a tab, a block is a pane. One `rex` call costs ~25ms, so the tab list is
//! one `rex do` Lua script (SNAPSHOT) that reads the session's view and each
//! terminal block's process, reported status and title over one connection:
//! ~30ms for a session of twenty tabs.
//!
//! Rex has no agent registry. As rex-agents does, a block runs an agent when
//! its foreground program is claude or codex, or when that program reported
//! an agent's status (OSC 7501), as a tab `o` or al opens does: there the
//! foreground program is the `sh -c` that runs the agent.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

use serde_json::{json, Value};

/// The session's tabs and their terminal blocks, in one connection. The
/// window holding block `block` (al's own) comes back as `mine` alone, unread.
const SNAPSHOT: &str = r#"
local sid, me = rex.args.session, rex.args.block
local ok, view = pcall(rex.call, "session.view", { session_id = sid })
if not ok or not view then view = (rex.call("session.attach", { session_id = sid }) or {}).view or {} end
local function call(bid, method)
  local ok, r = pcall(rex.call, "block.method", { session_id = sid, block_id = bid, method = method })
  if ok then return r end
end
local out = { label = view.label or "", windows = {} }
for _, w in ipairs(view.windows or {}) do
  local blocks, mine = {}, false
  for _, layer in ipairs(w.layers or {}) do
    for _, b in ipairs(layer.blocks or {}) do
      if b.block_id == me then mine = true end
      if b.creator_name == "com.superlogical.terminal" then table.insert(blocks, b.block_id) end
    end
  end
  local win = { window_id = w.window_id, label = w.label or "", focused_block_id = w.focused_block_id, mine = mine, blocks = {} }
  if not mine then
    for _, bid in ipairs(blocks) do
      table.insert(win.blocks, { block_id = bid, process = call(bid, "process"), status = call(bid, "program_status"), title = call(bid, "title") })
    end
  end
  table.insert(out.windows, win)
end
return out
"#;

/// The Rex session al runs in ($REX_SESSION).
pub fn session() -> Option<String> {
    std::env::var("REX_SESSION").ok().filter(|s| !s.is_empty())
}

fn need_session() -> Result<String, String> {
    session().ok_or_else(|| "not in a Rex pane (no REX_SESSION)".to_string())
}

pub struct Tab {
    /// The Rex window's ID.
    pub id: String,
    pub label: String,
    /// The pane the preview shows: the tab's focused block.
    pub pane: Option<String>,
    /// working · idle · done · blocked · error · unknown, or none (no agent)
    pub status: String,
    /// The agent's terminal title, else the pane's directory.
    pub title: String,
    pub cwd: String,
    /// The agent's session ID (`Y` copies it): a Claude agent's, from
    /// ~/.claude/sessions. Codex's isn't findable from its process.
    pub session: Option<String>,
    /// A Claude agent's session ID: its transcript has what its screen doesn't.
    pub claude_session: Option<String>,
    /// The block the tab's agent runs in (`r` replies to it): the shown
    /// block's agent, else the first one in the tab.
    pub agent_pane: Option<String>,
    /// Every agent in the tab: its block, and its session ID. A reply draft
    /// finds its agent here, even when the tab now shows another.
    pub agents: Vec<(String, Option<String>)>,
}

impl Tab {
    /// What the tab bar calls it: its label, else its ID.
    pub fn name(&self) -> &str {
        if self.label.is_empty() {
            &self.id
        } else {
            &self.label
        }
    }
}

/// One terminal block, as the snapshot read it.
struct Block {
    id: String,
    /// claude or codex, when an agent runs there.
    kind: Option<&'static str>,
    state: String,
    title: String,
    cwd: String,
    /// The foreground process: its pid, and the names it goes by.
    pid: Option<u32>,
    names: Vec<String>,
}

/// A JSON array, or nothing (Lua sends an empty table as `{}`).
fn list(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

fn str_of(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or("").to_string()
}

/// A program's names, as rex-agents compares them: argv0, the paths it was
/// started from, its process name; each a basename without a login shell's -.
fn names(fg: &Value) -> Vec<String> {
    ["argv0", "invoked_path", "path", "name"]
        .iter()
        .filter_map(|k| fg[*k].as_str())
        .map(|s| s.rsplit('/').next().unwrap_or(s).trim_start_matches('-').to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

fn agent_app(name: &str) -> Option<&'static str> {
    match name {
        "claude" | "claude-code" => Some("claude"),
        "codex" => Some("codex"),
        _ => None,
    }
}

fn block(b: &Value) -> Block {
    let fg = &b["process"]["foreground"];
    let pid = fg["pid"].as_u64().map(|p| p as u32);
    let names = names(fg);
    // Only the foreground program's records count, so a finished agent's
    // last report doesn't linger on the shell it left (rex-agents' rule).
    let records: Vec<&Value> = list(&b["status"]["records"])
        .iter()
        .filter(|r| r["owner"]["pid"].as_u64().is_none_or(|o| Some(o as u32) == pid))
        .collect();
    let kind = names.iter().find_map(|n| agent_app(n)).or_else(|| {
        records.iter().find_map(|r| agent_app(&r["effective_app"].as_str().or(r["app"].as_str()).unwrap_or("").to_ascii_lowercase()))
    });
    let root = records.iter().find(|r| r["id"].is_null()).or(records.first());
    let state = root.and_then(|r| r["state"].as_str()).filter(|s| !s.is_empty()).unwrap_or("unknown").to_string();
    let ancestor = list(&b["process"]["ancestors"]).iter().find_map(|a| a["cwd"].as_str()).unwrap_or("");
    let cwd = fg["cwd"].as_str().filter(|c| !c.is_empty()).unwrap_or(ancestor).to_string();
    Block { id: str_of(b, "block_id"), kind, state, title: strip_title(b["title"]["title"].as_str().unwrap_or("")), cwd, pid, names }
}

/// A terminal title without the spinner or status glyph an agent puts in
/// front of it (Claude Code's ✳ and braille dots).
fn strip_title(t: &str) -> String {
    let glyph = |c: char| c.is_whitespace() || matches!(c as u32, 0x2190..=0x2BFF) || matches!(c, '·' | '•' | '*');
    t.trim_start_matches(glyph).trim_end().to_string()
}

/// Which of the tab's agents' states the dot shows: the one that most
/// wants you.
fn rank(state: &str) -> u8 {
    match state {
        "blocked" => 0,
        "error" => 1,
        "working" => 2,
        "done" => 3,
        "idle" => 4,
        _ => 5,
    }
}

/// The tabs of session `ses` in tab-bar order, leaving out the one holding
/// block `me` (al's own) and tabs that are only another al, jv, jg or ctab;
/// and the session's name.
pub fn tabs(ses: &str, me: &str) -> Result<(String, Vec<Tab>), String> {
    let (s, b) = (format!("session={ses}"), format!("block={}", if me.is_empty() { "-" } else { me }));
    let out = rex(&["do", "-e", SNAPSHOT, &s, &b, "--json"])?;
    let snap: Value = serde_json::from_str(&out).map_err(|e| format!("rex do: {e}"))?;
    let claude = claude_sessions();
    let session_of = |b: &Block| match b.kind {
        Some("claude") => b.pid.and_then(|p| claude.get(&p).cloned()),
        _ => None,
    };
    let tabs = list(&snap["windows"])
        .iter()
        .filter(|w| w["mine"] != true)
        .filter_map(|w| {
            let blocks: Vec<Block> = list(&w["blocks"]).iter().map(block).collect();
            let focused = w["focused_block_id"].as_str().unwrap_or("");
            let shown = blocks.iter().find(|b| b.id == focused).or(blocks.first());
            let agent = shown.filter(|b| b.kind.is_some()).or_else(|| blocks.iter().find(|b| b.kind.is_some()));
            // Another al, jv, jg or ctab with no agent beside it: nothing to read or reply to.
            let switcher = |b: &Block| b.names.iter().any(|n| matches!(n.as_str(), "al" | "jv" | "ctab"));
            if agent.is_none() && blocks.iter().any(switcher) {
                return None;
            }
            let cwd = shown.map(|b| b.cwd.clone()).unwrap_or_default();
            let title = agent.map(|a| a.title.clone()).filter(|t| !t.is_empty()).unwrap_or_else(|| tilde(&cwd));
            let session = agent.and_then(session_of);
            let claude_session = session.clone().filter(|_| agent.is_some_and(|a| a.kind == Some("claude")));
            let mine: Vec<&Block> = blocks.iter().filter(|b| b.kind.is_some()).collect();
            let status = mine.iter().map(|b| b.state.as_str()).min_by_key(|s| rank(s)).unwrap_or("none").to_string();
            Some(Tab {
                id: str_of(w, "window_id"),
                label: str_of(w, "label"),
                pane: shown.map(|b| b.id.clone()),
                status,
                title,
                cwd,
                session,
                claude_session,
                agent_pane: agent.map(|a| a.id.clone()),
                agents: mine.iter().map(|b| (b.id.clone(), session_of(b))).collect(),
            })
        })
        .collect();
    Ok((str_of(&snap, "label"), tabs))
}

/// Running Claude Codes' session IDs (~/.claude/sessions/PID.json), by the
/// pid of each one and of its parent: the parent is the foreground program
/// of a tab that runs claude under `sh -c` (o's and al's tabs).
fn claude_sessions() -> HashMap<u32, String> {
    let mut by_pid = HashMap::new();
    let Some(home) = std::env::var_os("HOME") else { return by_pid };
    let Ok(dir) = std::fs::read_dir(PathBuf::from(home).join(".claude/sessions")) else { return by_pid };
    let mut parents = Vec::new();
    for e in dir.flatten() {
        let p = e.path();
        if p.extension().is_none_or(|x| x != "json") {
            continue;
        }
        let Some(v) = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { continue };
        let (Some(pid), Some(id)) = (v["pid"].as_u64(), v["sessionId"].as_str()) else { continue };
        let pid = pid as u32;
        // A file whose process is gone has no parent: leave it out.
        let Some(parent) = ppid(pid) else { continue };
        by_pid.insert(pid, id.to_string());
        parents.push((parent, id.to_string()));
    }
    for (parent, id) in parents {
        by_pid.entry(parent).or_insert(id);
    }
    by_pid
}

#[cfg(target_os = "macos")]
fn ppid(pid: u32) -> Option<u32> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: `info` is a proc_bsdinfo, and `size` is its size.
    let n = unsafe {
        libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size)
    };
    (n == size).then_some(info.pbi_ppid)
}

#[cfg(not(target_os = "macos"))]
fn ppid(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit(')').next()?.split_whitespace().nth(1)?.parse().ok()
}

/// Whether `bin` is on $PATH.
pub fn which(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(bin).is_file()))
        .unwrap_or(false)
}

/// `/Users/me/x` → `~/x`.
pub fn tilde(path: &str) -> String {
    match std::env::var("HOME") {
        Ok(h) if !h.is_empty() && path.starts_with(&h) => format!("~{}", &path[h.len()..]),
        _ => path.to_string(),
    }
}

/// How many of a pane's last lines the preview keeps.
const LINES: usize = 2000;

/// Block `block`'s latest lines with their colors (escape sequences): its
/// scrollback, which ends with what it shows now. A full-screen app has only
/// its screen. Rex hands over the whole scrollback; the last LINES stay.
pub fn read(block: &str) -> Result<String, String> {
    let ses = need_session()?;
    let mut text = rex(&["capture", "-s", &ses, "-b", block, "--format=vt", "--trim"])?;
    if let Some((i, _)) = text.trim_end().match_indices('\n').nth_back(LINES - 1) {
        text.drain(..=i);
    }
    Ok(text)
}

/// Make window `tab` the session's active one: the app shows it.
pub fn focus_tab(tab: &str) -> Result<(), String> {
    rex(&["focus", "-s", &need_session()?, tab]).map(drop)
}

/// Close window `tab` and every pane in it.
pub fn close_tab(tab: &str) -> Result<(), String> {
    rex(&["window", "close", "-s", &need_session()?, tab]).map(drop)
}

/// The window block `block` is in.
pub fn window_of(block: &str) -> Option<String> {
    let v: Value = serde_json::from_str(&rex(&["block", "inspect", "-s", &session()?, block, "--json"]).ok()?).ok()?;
    v["block"]["window_id"].as_str().map(String::from)
}

/// What Rex calls window `id`: its label, else the end of its ID, as Rex
/// shortens it (`Window 023f56b0`).
pub fn window_label(id: &str) -> String {
    let label = (|| {
        let v: Value = serde_json::from_str(&rex(&["window", "ls", "-s", &session()?, "--json"]).ok()?).ok()?;
        let all = v.as_array().or_else(|| v["windows"].as_array())?;
        let w = all.iter().find(|w| w["window_id"] == id)?;
        w["label"].as_str().filter(|s| !s.is_empty()).map(String::from)
    })();
    label.unwrap_or_else(|| id.get(id.len().saturating_sub(8)..).unwrap_or(id).to_string())
}

/// A new tab in this session, in `cwd`, at a shell that `input` is typed
/// into once it's up (end it with a newline to run it). `focus` goes there.
/// Its window and its block.
pub fn new_tab(cwd: &str, label: &str, focus: bool, input: &str) -> Result<(String, String), String> {
    let ses = need_session()?;
    let mut call = json!({
        "session_id": ses,
        "focus": focus,
        "layout": { "block": { "flavor": "com.superlogical.terminal.shell", "options": { "cwd": cwd, "initial_input": input } } },
    });
    if !label.is_empty() {
        call["window_label"] = label.into();
    }
    let out = rex(&["api", "call", "-s", &ses, "session.new_window", &call.to_string()])?;
    let v: Value = serde_json::from_str(&out).map_err(|e| format!("new window: {e}"))?;
    let window = v["window_id"].as_str().ok_or("new window returned no window")?.to_string();
    let block = list(&v["block_ids"]).first().and_then(Value::as_str).ok_or("new window returned no pane")?.to_string();
    Ok((window, block))
}

/// After the agent exits, the tab's login shell, in the agent's folder.
const THEN_SHELL: &str = r#""$@"; exec "${SHELL:-/bin/zsh}" -l"#;

/// A new tab in the background, in `cwd`, running `program ARGS… -- PROMPT`
/// (`o`'s way: the prompt is the agent's argument, so nothing waits for a
/// shell), then a login shell once it exits. `--interactive`: ~/.zshrc too,
/// so the agent sees what a shell tab would. Its window.
pub fn start_agent(program: &str, args: &[String], prompt: &str, cwd: &str) -> Result<String, String> {
    let ses = need_session()?;
    let mut cmd = vec!["window", "new", "-s", &ses, "-c", cwd, "--interactive", "--focus=false", "--json", "--", "sh", "-c", THEN_SHELL, "al", program];
    cmd.extend(args.iter().map(String::as_str));
    // `--`: a prompt starting with - isn't read as an option (Claude Code and
    // Codex both take it).
    cmd.extend(["--", prompt]);
    let out = rex(&cmd)?;
    let v: Value = serde_json::from_str(&out).map_err(|e| format!("window new: {e}"))?;
    v["window_id"].as_str().map(String::from).ok_or_else(|| "window new returned no window".to_string())
}

/// Hand `prompt` to the agent in `block`: pasted, then Enter, as typing it in
/// would be (o's reply).
pub fn paste_enter(block: &str, prompt: &str) -> Result<(), String> {
    let ses = need_session()?;
    let call = json!({ "session_id": ses, "block_id": block, "event": { "type": "paste", "payload": { "text": prompt } } });
    rex(&["api", "call", "-s", &ses, "block.event", &call.to_string()])?;
    rex(&["send-key", "-s", &ses, "-b", block, "enter"]).map(drop)
}

/// Open `file` at `line`:`col` in Neovim in a floating pane over al's tab,
/// gone when it quits: Herdr's nvim-links popup, from the file's repo root.
pub fn nvim_popup(file: &str, line: usize, col: usize) -> Result<(), String> {
    let ses = need_session()?;
    let dir = std::path::Path::new(file).parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let root = Command::new("git")
        .args(["-C", &dir, "rev-parse", "--show-toplevel"])
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|r| !r.is_empty())
        .unwrap_or(dir);
    let mut call = json!({
        "session_id": ses,
        "bounds": [0.08, 0.08, 0.84, 0.84],
        "focus": true,
        "layout": { "block": { "flavor": "com.superlogical.terminal.shell", "label": "nvim", "options": {
            "cwd": root,
            "command": ["nvim", format!("+call cursor({line}, {col})"), "+normal! zz", "--", file],
        } } },
    });
    if let Some(w) = std::env::var("REX_BLOCK").ok().and_then(|b| window_of(&b)) {
        call["window_id"] = w.into();
    }
    rex(&["api", "call", "-s", &ses, "session.new_layer", &call.to_string()]).map(drop)
}

/// Run `rex ARGS`: stdout on success, else the error's message.
pub fn rex(args: &[&str]) -> Result<String, String> {
    let out = Command::new("rex").args(args).stdin(Stdio::null()).output().map_err(|e| format!("rex: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    Err(failure(&out))
}

/// A failed rex call's error message: a JSON error's, else the first line
/// that says something.
fn failure(out: &Output) -> String {
    let all = format!("{}{}", String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout));
    let json = all.lines().find_map(|l| serde_json::from_str::<Value>(l).ok());
    let msg = json.as_ref().and_then(|v| v["error"]["message"].as_str().or(v["message"].as_str())).map(String::from);
    msg.unwrap_or_else(|| all.trim().lines().next().unwrap_or("failed").trim_start_matches("Error: ").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_lose_the_agents_glyphs() {
        assert_eq!(strip_title("✳ Port al to Rex"), "Port al to Rex");
        assert_eq!(strip_title("⠐ Working on it "), "Working on it");
        assert_eq!(strip_title("~/x  y"), "~/x  y");
    }

    #[test]
    fn a_block_under_sh_is_an_agent_by_its_status() {
        let b = json!({
            "block_id": "block:1",
            "process": { "foreground": { "pid": 7, "argv0": "sh", "name": "bash", "cwd": "/tmp/x" } },
            "status": { "records": [
                { "state": "done", "app": "claude-code", "owner": { "pid": 7 } },
                { "id": "t1", "state": "working", "app": "claude-code", "owner": { "pid": 7 } },
                { "state": "blocked", "app": "codex", "owner": { "pid": 99 } },
            ] },
            "title": { "title": "✳ Fix it" },
        });
        let b = block(&b);
        assert_eq!((b.kind, b.state.as_str(), b.title.as_str(), b.cwd.as_str()), (Some("claude"), "done", "Fix it", "/tmp/x"));
    }

    #[test]
    fn a_shell_is_no_agent() {
        let b = json!({
            "block_id": "block:2",
            "process": { "foreground": { "pid": 8, "argv0": "-zsh", "path": "/bin/zsh" }, "ancestors": [{ "cwd": "/home" }] },
            "status": {},
            "title": {},
        });
        let b = block(&b);
        assert_eq!((b.kind, b.state.as_str(), b.cwd.as_str(), b.names.contains(&"zsh".to_string())), (None, "unknown", "/home", true));
    }

    #[test]
    fn the_dot_shows_the_most_urgent_agent() {
        let states = ["idle", "working", "blocked", "done"];
        assert_eq!(states.iter().min_by_key(|s| rank(s)), Some(&"blocked"));
    }
}
