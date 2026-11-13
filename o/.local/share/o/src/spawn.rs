//! Sending: a new Rex tab (a window) in this session, running the agent with
//! the prompt as its first message. The Rex call runs in a child process,
//! `o --start-agent …`, in its own process group, so quitting o right after
//! ⏎ still gets the agent started.
//!
//! The tab runs `sh -c '"$@"; exec $SHELL -l' o AGENT ARGS… -- PROMPT`: the
//! agent gets the prompt as an argument (no waiting for a shell to be ready
//! to type into), and when it exits the tab is left at a shell in its
//! folder, as a tab that had the agent typed into it would be.
//!
//! Which agent, and its arguments, is the configuration the prompt is on
//! (config.rs).

use std::ffi::OsString;
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, ExitCode, Output, Stdio};
use std::sync::mpsc;
use std::thread;

use serde_json::{json, Value};

use crate::config::Agent;

/// Internal: `o --start-agent CWD KIND PROMPT LABEL FOCUS [ARGS…]` does the
/// Rex call; ARGS go to the agent.
pub const CHILD_FLAG: &str = "--start-agent";

/// The Rex session o runs in: every tab it opens goes there.
fn session() -> Option<String> {
    std::env::var("REX_SESSION").ok().filter(|s| !s.is_empty())
}

pub fn in_rex() -> bool {
    session().is_some()
}

/// One send: its display line, whether it worked, and its focus target (the
/// agent's block).
pub type Outcome = (String, bool, Option<String>);

/// Start `agent` with `prompt` in a new tab in `cwd`, in the background.
/// `label` names the tab (empty: Rex's own name for it); `focus` goes there.
/// The outcome comes back on `tx`, tagged `n`.
pub fn send(n: usize, agent: &Agent, prompt: &str, cwd: &Path, label: &str, focus: bool, tx: mpsc::Sender<(usize, Outcome)>) {
    let mut args: Vec<OsString> = vec![
        CHILD_FLAG.into(),
        cwd.into(),
        agent.kind.as_str().into(),
        prompt.into(),
        label.into(),
        if focus { "1" } else { "0" }.into(),
    ];
    args.extend(agent.args.iter().map(OsString::from));
    let kind = agent.name.clone();
    thread::spawn(move || {
        let child = std::env::current_exe().and_then(|exe| {
            Command::new(exe)
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                // Its own process group: nothing aimed at o's job reaches it.
                .process_group(0)
                .spawn()
        });
        let out = match child.and_then(|c| c.wait_with_output()) {
            Ok(o) => {
                let msg = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if o.status.success() {
                    serde_json::from_str::<Outcome>(&msg).unwrap_or_else(|e| (format!("invalid start result: {e}"), false, None))
                } else {
                    (if msg.is_empty() { format!("{kind} didn't start") } else { msg }, false, None)
                }
            }
            Err(e) => (format!("couldn't start {kind}: {e}"), false, None),
        };
        let _ = tx.send((n, out));
    });
}

/// The `--start-agent` process: one line on stdout says how it went.
pub fn child(args: &[String]) -> ExitCode {
    let [cwd, kind, prompt, label, focus, agent_args @ ..] = args else { return ExitCode::from(2) };
    let res = start(kind, agent_args, prompt, Path::new(cwd), label, focus == "1");
    let output = match &res {
        Ok(out) => serde_json::to_string(out).expect("serializable outcome"),
        Err(e) => e.clone(),
    };
    let _ = writeln!(std::io::stdout(), "{output}");
    if res.is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// After the agent exits, the tab's login shell, in the agent's folder.
const THEN_SHELL: &str = r#""$@"; exec "${SHELL:-/bin/zsh}" -l"#;
/// The same, run by an interactive shell: `command` skips its functions, so
/// `codex` is the binary and not ~/.config/zsh/codex.zsh's wrapper.
const THEN_SHELL_RC: &str = r#"command "$@"; exec "${SHELL:-/bin/zsh}" -l"#;

fn start(kind: &str, args: &[String], prompt: &str, cwd: &Path, label: &str, focus: bool) -> Result<Outcome, String> {
    let ses = session().ok_or("not in a Rex terminal (no REX_SESSION)")?;
    let cwd = cwd.to_string_lossy();
    let focus = if focus { "--focus=true" } else { "--focus=false" };
    let mut head = vec!["window", "new", "-s", &ses];
    if !label.is_empty() {
        head.push(label);
    }
    head.extend(["-c", &cwd, focus, "--json"]);
    let mut agent = vec!["o", kind];
    agent.extend(args.iter().map(String::as_str));
    // `--`: a prompt starting with - isn't read as an option (Claude Code and
    // Codex both take it).
    agent.extend(["--", prompt]);
    // --interactive: ~/.zshrc too, so the agent sees what a shell tab would.
    let native = [&head[..], &["--interactive", "--", "sh", "-c", THEN_SHELL], &agent].concat();
    let out = match rex(&native) {
        // Servers older than --interactive (the Oct 29 build): the shell reads
        // ~/.zshrc itself, as `zsh -i`.
        Err(e) if e.contains("unknown flag: --interactive") => {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            rex(&[&head[..], &["--", &shell, "-ic", THEN_SHELL_RC], &agent].concat())
        }
        res => res,
    };
    let out = out.map_err(|e| format!("couldn't open a tab: {e}"))?;
    let out: Value = serde_json::from_str(&out).map_err(|e| format!("window new: {e}"))?;
    let block = out["block_ids"][0].as_str().ok_or("window new returned no block")?.to_string();
    let window = out["window_id"].as_str().unwrap_or("");
    let shown = if label.is_empty() { window_label(&ses, window).unwrap_or_else(|| short(window)) } else { label.to_string() };
    Ok((format!("→ tab {shown}"), true, Some(block)))
}

/// What Rex calls window `id` in session `ses`.
fn window_label(ses: &str, id: &str) -> Option<String> {
    let v: Value = serde_json::from_str(&rex(&["window", "ls", "-s", ses, "--json"]).ok()?).ok()?;
    let list = v.as_array().or_else(|| v["windows"].as_array())?;
    let w = list.iter().find(|w| w["window_id"] == id)?;
    w["label"].as_str().filter(|s| !s.is_empty()).map(String::from)
}

/// An ID's last 8 characters, as Rex shortens them (`Window 023f56b0`).
fn short(id: &str) -> String {
    id.get(id.len().saturating_sub(8)..).unwrap_or(id).to_string()
}

/// Send `prompt` to the agent in `block` (a reply draft's), in the
/// background: pasted, then Enter, as typing it in would. The outcome comes
/// back on `tx`, tagged `n`.
pub fn reply(n: usize, block: &str, prompt: &str, tx: mpsc::Sender<(usize, Outcome)>) {
    let (block, prompt) = (block.to_string(), prompt.to_string());
    thread::spawn(move || {
        let out = match paste_enter(&block, &prompt) {
            Ok(()) => (format!("→ pane {}", short(&block)), true, Some(block.clone())),
            Err(e) => (format!("couldn't reply: {e}"), false, None),
        };
        let _ = tx.send((n, out));
    });
}

fn paste_enter(block: &str, prompt: &str) -> Result<(), String> {
    let ses = session().ok_or("not in a Rex terminal (no REX_SESSION)")?;
    let call = json!({ "session_id": ses, "block_id": block, "event": { "type": "paste", "payload": { "text": prompt } } });
    rex(&["api", "call", "-s", &ses, "block.event", &call.to_string()])?;
    rex(&["send-key", "-s", &ses, "-b", block, "enter"]).map(|_| ())
}

/// This Rex session: its id and its name (drafts are kept per session).
pub fn space() -> (String, String) {
    let Some(ses) = session() else { return (String::new(), String::new()) };
    let v = rex(&["session", "inspect", &ses, "--json"]).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let name = v.as_ref().and_then(|v| v["label"].as_str()).unwrap_or("").to_string();
    (ses, name)
}

/// The block a reply goes to now: `block` while it's still in this session.
/// None when it's gone.
pub fn agent_pane(block: &str, _session: Option<&str>) -> Option<String> {
    let ses = session()?;
    rex(&["block", "inspect", "-s", &ses, block, "--json"]).ok().map(|_| block.to_string())
}

/// Focus the block a send started its agent in; its tab comes up with it.
pub fn focus(block: &str) -> Result<(), String> {
    let ses = session().ok_or("not in a Rex terminal (no REX_SESSION)")?;
    rex(&["focus", "-s", &ses, block]).map(|_| ())
}

/// Run `rex ARGS`: stdout on success, else the error's message.
fn rex(args: &[&str]) -> Result<String, String> {
    let out = Command::new("rex").args(args).stdin(Stdio::null()).output().map_err(|e| format!("rex: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    Err(failure(&out))
}

/// A failed rex call's error message: its first line that says something.
fn failure(out: &Output) -> String {
    let all = format!("{}{}", String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout));
    // JSON errors carry a message; else the first non-empty line.
    let json = all.lines().find_map(|l| serde_json::from_str::<Value>(l).ok());
    let msg = json.as_ref().and_then(|v| v["error"]["message"].as_str().or(v["message"].as_str())).map(String::from);
    msg.unwrap_or_else(|| all.trim().lines().next().unwrap_or("failed").trim_start_matches("Error: ").to_string())
}
