//! Herdr, straight over its socket: one JSON request per connection (the
//! server hangs up after answering), about a millisecond where the herdr CLI
//! costs ~25ms a call.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::{json, Value};

fn socket() -> PathBuf {
    match std::env::var_os("HERDR_SOCKET_PATH") {
        Some(p) if !p.is_empty() => p.into(),
        _ => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config/herdr/herdr.sock"),
    }
}

/// One request; the `result` on success, the error's message otherwise.
pub fn call(method: &str, params: Value) -> Result<Value, String> {
    let mut s = UnixStream::connect(socket()).map_err(|e| format!("herdr socket: {e}"))?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    writeln!(s, "{}", json!({ "id": "al", "method": method, "params": params })).map_err(|e| format!("herdr: {e}"))?;
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).map_err(|e| format!("herdr: {e}"))?;
    let mut v: Value = serde_json::from_str(&line).map_err(|e| format!("herdr: {e}"))?;
    match v.get("error") {
        Some(e) => Err(e["message"].as_str().unwrap_or("herdr error").to_string()),
        None => Ok(v["result"].take()),
    }
}

pub struct Tab {
    pub id: String,
    pub label: String,
    /// The pane the preview shows: the tab's focused one.
    pub pane: Option<String>,
    /// working · idle · done · blocked · unknown
    pub status: String,
    /// The agent's session title, else the pane's directory.
    pub title: String,
    pub cwd: String,
    /// The agent's session ID (`Y` copies it), whatever the agent.
    pub session: Option<String>,
    /// A Claude agent's session ID: its transcript has what its screen doesn't.
    pub claude_session: Option<String>,
    /// The pane the tab's agent runs in (`r` replies to it): the shown pane's
    /// agent, else the first one in the tab.
    pub agent_pane: Option<String>,
}

impl Tab {
    /// What the sidebar calls it: its label, else its ID.
    pub fn name(&self) -> &str {
        if self.label.is_empty() {
            &self.id
        } else {
            &self.label
        }
    }
}

/// The tabs of workspace `ws` in sidebar order, leaving out tab `skip`
/// (al's own) and tabs that are only another al, jv, jg or ctab, and the workspace's name.
pub fn tabs(ws: &str, skip: &str) -> Result<(String, Vec<Tab>), String> {
    let snap = call("session.snapshot", json!({}))?;
    let s = &snap["snapshot"];
    let list = |k: &str| s[k].as_array().cloned().unwrap_or_default();
    let str_of = |v: &Value, k: &str| v[k].as_str().unwrap_or("").to_string();
    let name = list("workspaces").iter().find(|w| w["workspace_id"] == ws).map(|w| str_of(w, "label")).unwrap_or_default();
    let agents: HashMap<String, Value> = list("agents").into_iter().map(|a| (str_of(&a, "terminal_id"), a)).collect();
    let panes = list("panes");
    let focused: HashMap<String, String> =
        list("layouts").iter().map(|l| (str_of(l, "tab_id"), str_of(l, "focused_pane_id"))).collect();
    let tabs = list("tabs")
        .iter()
        .filter(|t| t["workspace_id"] == ws && t["tab_id"] != skip)
        .filter_map(|t| {
            let id = str_of(t, "tab_id");
            let mine: Vec<&Value> = panes.iter().filter(|p| p["tab_id"] == id.as_str()).collect();
            let pane = focused.get(&id).filter(|p| !p.is_empty()).cloned().or_else(|| mine.first().map(|p| str_of(p, "pane_id")));
            let shown = mine.iter().find(|p| Some(str_of(p, "pane_id")) == pane).or(mine.first());
            let cwd = shown.map(|p| str_of(p, "foreground_cwd")).filter(|c| !c.is_empty());
            let cwd = cwd.or_else(|| shown.map(|p| str_of(p, "cwd"))).unwrap_or_default();
            // The agent in this tab, if any (the shown pane's first): its title
            // says what the tab is doing.
            let agent_of = |p: &Value| -> Option<(String, &Value)> {
                agents.get(p["terminal_id"].as_str()?).map(|a| (str_of(p, "pane_id"), a))
            };
            let agent = shown.and_then(|p| agent_of(p)).or_else(|| mine.iter().find_map(|p| agent_of(p)));
            // Another al, jv, jg or ctab with no agent beside it: nothing to read or reply to.
            if agent.is_none() && mine.iter().any(|p| runs_switcher(&str_of(p, "pane_id"))) {
                return None;
            }
            let title = agent.as_ref().map(|(_, a)| str_of(a, "terminal_title_stripped")).filter(|t| !t.is_empty());
            let title = title.unwrap_or_else(|| tilde(&cwd));
            let session = agent.as_ref().and_then(|(_, a)| a["agent_session"]["value"].as_str()).filter(|s| !s.is_empty()).map(String::from);
            let claude_session = session.clone().filter(|_| agent.as_ref().is_some_and(|(_, a)| a["agent"] == "claude"));
            let agent_pane = agent.map(|(p, _)| p).filter(|p| !p.is_empty());
            Some(Tab { label: str_of(t, "label"), pane, status: str_of(t, "agent_status"), title, cwd, session, claude_session, agent_pane, id })
        })
        .collect();
    Ok((name, tabs))
}

/// Whether pane `pane` is running al, jv or ctab in the foreground (`jg`
/// is `jv -g`, so it's jv too). The snapshot doesn't carry processes; this is
/// ~0.3ms a pane.
fn runs_switcher(pane: &str) -> bool {
    let Ok(r) = call("pane.process_info", json!({ "pane_id": pane })) else { return false };
    r["process_info"]["foreground_processes"].as_array().is_some_and(|ps| ps.iter().any(|p| matches!(p["name"].as_str(), Some("al" | "jv" | "ctab"))))
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

/// Pane `pane`'s latest lines with their colors (ANSI): its scrollback, which
/// ends with what it shows now. A full-screen app (Claude Code) has only its screen.
pub fn read(pane: &str) -> Result<String, String> {
    let r = call("pane.read", json!({ "pane_id": pane, "source": "recent", "lines": 2000, "format": "ansi" }))?;
    Ok(r["read"]["text"].as_str().unwrap_or("").to_string())
}

pub fn focus_tab(tab: &str) -> Result<(), String> {
    call("tab.focus", json!({ "tab_id": tab })).map(drop)
}

/// Close a tab at once. `herdr-close` SIGKILLs its agents first, since
/// Herdr's own close waits out each agent's shutdown with the UI frozen.
pub fn close_tab(tab: &str) -> Result<(), String> {
    if !which("herdr-close") {
        return call("tab.close", json!({ "tab_id": tab })).map(drop);
    }
    let out = Command::new("herdr-close")
        .args(["tab", tab])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .output()
        .map_err(|e| format!("herdr-close: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().trim_start_matches("herdr-close: ").to_string())
    }
}
