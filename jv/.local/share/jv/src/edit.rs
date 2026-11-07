//! `E`: open a file in nvim in a new Herdr tab and go there. The command is
//! typed into the tab's shell, as `C` does, so quitting nvim lands on a prompt
//! in the repo.

use std::path::Path;

use serde_json::Value;

use crate::agent;

/// What the tab runs, from the repo root. `--` so a path can't read as a flag.
pub fn command(rel: &str, line: u32) -> String {
    format!("nvim +{line} -- '{}'", rel.replace('\'', r"'\''"))
}

pub fn open(root: &Path, rel: &str, line: u32) -> Result<(), String> {
    let ws = std::env::var("HERDR_WORKSPACE_ID").map_err(|_| "not in a Herdr pane (no HERDR_WORKSPACE_ID)".to_string())?;
    let root = root.to_string_lossy();
    let label = rel.rsplit('/').next().unwrap_or(rel);
    let tab = agent::herdr(&["tab", "create", "--workspace", &ws, "--cwd", &root, "--label", label, "--focus"])
        .map_err(|e| format!("couldn't open a tab: {e}"))?;
    let tab: Value = serde_json::from_str(&tab).map_err(|e| format!("tab create: {e}"))?;
    let pane = tab["result"]["root_pane"]["pane_id"].as_str().ok_or("tab create returned no pane")?;
    agent::herdr(&["pane", "run", pane, &command(rel, line)]).map_err(|e| format!("the tab is open, but nvim didn't start: {e}"))?;
    Ok(())
}
