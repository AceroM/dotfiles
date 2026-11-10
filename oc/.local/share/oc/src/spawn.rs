//! Sending: a new Herdr tab in this space, the agent started in it, the
//! prompt handed over (al's `c`). The Herdr calls run in a child process,
//! `oc --start-agent …`, in its own process group, so quitting oc right after
//! ⏎ still gets the agent its prompt.
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
use std::time::Duration;

use serde_json::Value;

use crate::config::Agent;

/// Internal: `oc --start-agent CWD KIND PROMPT LABEL FOCUS [ARGS…]` does the
/// Herdr calls; ARGS go to the agent.
pub const CHILD_FLAG: &str = "--start-agent";

pub fn in_herdr() -> bool {
    std::env::var("HERDR_ENV").as_deref() == Ok("1")
}

/// One send, as the child reports it: its line, and whether it worked.
pub type Outcome = (String, bool);

/// Start `agent` with `prompt` in a new tab in `cwd`, in the background.
/// `label` names the tab (empty: Herdr's, until the Stop hook names it);
/// `focus` goes there. The outcome comes back on `tx`, tagged `n`.
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
                // Its own process group: nothing aimed at oc's job reaches it.
                .process_group(0)
                .spawn()
        });
        let out = match child.and_then(|c| c.wait_with_output()) {
            Ok(o) => {
                let msg = String::from_utf8_lossy(&o.stdout).trim().to_string();
                (if msg.is_empty() { format!("{kind} didn't start") } else { msg }, o.status.success())
            }
            Err(e) => (format!("couldn't start {kind}: {e}"), false),
        };
        let _ = tx.send((n, out));
    });
}

/// The `--start-agent` process: one line on stdout says how it went.
pub fn child(args: &[String]) -> ExitCode {
    let [cwd, kind, prompt, label, focus, agent_args @ ..] = args else { return ExitCode::from(2) };
    let res = start(kind, agent_args, prompt, Path::new(cwd), label, focus == "1");
    let _ = writeln!(std::io::stdout(), "{}", res.as_ref().unwrap_or_else(|e| e));
    if res.is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn start(kind: &str, args: &[String], prompt: &str, cwd: &Path, label: &str, focus: bool) -> Result<String, String> {
    let ws = std::env::var("HERDR_WORKSPACE_ID").map_err(|_| "not in a Herdr pane (no HERDR_WORKSPACE_ID)".to_string())?;
    let cwd = cwd.to_string_lossy();
    let mut cmd = vec!["tab", "create", "--workspace", &ws, "--cwd", &cwd, if focus { "--focus" } else { "--no-focus" }];
    if !label.is_empty() {
        cmd.extend(["--label", label]);
    }
    let tab = herdr(&cmd).map_err(|e| format!("couldn't open a tab: {e}"))?;
    let tab: Value = serde_json::from_str(&tab).map_err(|e| format!("tab create: {e}"))?;
    let pane = tab["result"]["root_pane"]["pane_id"].as_str().ok_or("tab create returned no pane")?.to_string();
    let label = tab["result"]["tab"]["label"].as_str().unwrap_or("").to_string();
    // Agent names are [a-z][a-z0-9_-]{0,31}; pane IDs are unique, and their
    // only uppercase is base-36 digits, so lowercasing keeps them unique.
    let name = format!("{kind}-{}", pane.to_ascii_lowercase().replace(':', "-"));
    let mut cmd = vec!["agent", "start", &name, "--kind", kind, "--pane", &pane];
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
    Ok(format!("→ tab {label}"))
}

/// Send `prompt` to the agent in `pane` (a reply draft's), in the
/// background. The outcome comes back on `tx`, tagged `n`.
pub fn reply(n: usize, pane: &str, prompt: &str, tx: mpsc::Sender<(usize, Outcome)>) {
    let (pane, prompt) = (pane.to_string(), prompt.to_string());
    thread::spawn(move || {
        // No `--`: Herdr would read a prompt starting with - as an option.
        let out = match herdr(&["agent", "prompt", &pane, &prompt]) {
            Ok(_) => (format!("→ pane {pane}"), true),
            Err(e) => (format!("couldn't reply: {e}"), false),
        };
        let _ = tx.send((n, out));
    });
}

/// This Herdr space: its id and its name (drafts are kept per space).
pub fn space() -> (String, String) {
    let ws = std::env::var("HERDR_WORKSPACE_ID").unwrap_or_default();
    let all = herdr(&["workspace", "list"]).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let name = all.as_ref().and_then(|v| v["result"]["workspaces"].as_array()).and_then(|a| a.iter().find(|w| w["workspace_id"] == ws.as_str()));
    let name = name.and_then(|w| w["label"].as_str()).unwrap_or("").to_string();
    (ws, name)
}

/// The pane a reply goes to now: `pane` while an agent runs there, else the
/// pane `session`'s agent is in. None when that agent is gone.
pub fn agent_pane(pane: &str, session: Option<&str>) -> Option<String> {
    let ws = std::env::var("HERDR_WORKSPACE_ID").ok()?;
    let all: Value = serde_json::from_str(&herdr(&["pane", "list", "--workspace", &ws]).ok()?).ok()?;
    let panes = all["result"]["panes"].as_array()?;
    let agents = || panes.iter().filter(|p| p["agent"].as_str().is_some_and(|a| !a.is_empty()));
    let found = agents().find(|p| p["pane_id"] == pane);
    let found = found.or_else(|| agents().find(|p| session.is_some() && p["agent_session"]["value"].as_str() == session));
    found.and_then(|p| p["pane_id"].as_str()).map(String::from)
}

/// Run `herdr ARGS`: stdout on success, else the error's message.
fn herdr(args: &[&str]) -> Result<String, String> {
    let out = Command::new("herdr").args(args).stdin(Stdio::null()).output().map_err(|e| format!("herdr: {e}"))?;
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
    // Keep the code in the text: `start` matches on it (agent_pane_busy).
    if code.is_empty() || msg.contains(&code) {
        msg
    } else {
        format!("{msg} ({code})")
    }
}

