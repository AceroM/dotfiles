//! Where a page was written: the checkout, slot, branch and SHA, the ticket the branch names, and
//! the herdr tab and agent session that wrote it. Gathered by the CLI, stored with every revision.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::process::Command;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Context {
    pub cwd: Option<String>,
    pub repo_root: Option<String>,
    pub repo: Option<String>,
    pub slot: Option<i64>,
    pub branch: Option<String>,
    pub sha: Option<String>,
    pub dirty: Option<bool>,
    pub ticket: Option<String>,
    pub github: Option<String>,
    pub herdr_workspace: Option<String>,
    pub herdr_tab: Option<String>,
    pub herdr_tab_label: Option<String>,
    pub herdr_pane: Option<String>,
    pub chat_title: Option<String>,
    pub agent: Option<String>,
    pub session_id: Option<String>,
    pub source_file: Option<String>,
}

fn run(program: &str, dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new(program).current_dir(dir).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Some(text)
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty())
}

/// With `ARTIFACTS_SLOT_REPO=<name>`, a checkout named `<name>` is slot 1 and `<name>.<N>` is slot N.
/// Any other checkout, or no variable, has no slot.
pub fn slot_of(repo_root: &str) -> Option<i64> {
    let base = non_empty(std::env::var("ARTIFACTS_SLOT_REPO").ok())?;
    let name = Path::new(repo_root).file_name()?.to_str()?;
    if name == base {
        return Some(1);
    }
    name.strip_prefix(base.as_str())?.strip_prefix('.')?.parse().ok()
}

/// `me/abc-123-fix-login` → `ABC-123`.
pub fn ticket_of(branch: &str) -> Option<String> {
    let re = Regex::new(r"(?i)(?:^|/)([a-z]{2,5})-(\d{2,6})(?:-|$)").ok()?;
    let caps = re.captures(branch)?;
    Some(format!("{}-{}", caps[1].to_ascii_uppercase(), &caps[2]))
}

/// `git@github.com:owner/repo.git` or `https://github.com/owner/repo` → `owner/repo`.
fn github_of(remote: &str) -> Option<String> {
    let rest = remote
        .strip_prefix("git@github.com:")
        .or_else(|| remote.strip_prefix("https://github.com/"))
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))?;
    Some(rest.trim_end_matches(".git").trim_end_matches('/').to_string())
}

pub fn gather(cwd: &Path) -> Context {
    let mut ctx = Context { cwd: Some(cwd.display().to_string()), ..Context::default() };

    if let Some(root) = non_empty(run("git", cwd, &["rev-parse", "--show-toplevel"])) {
        let root_path = Path::new(&root);
        ctx.repo = root_path.file_name().and_then(|n| n.to_str()).map(str::to_string);
        ctx.slot = slot_of(&root);
        ctx.branch = non_empty(run("git", root_path, &["branch", "--show-current"]));
        ctx.sha = non_empty(run("git", root_path, &["rev-parse", "HEAD"]));
        ctx.dirty = run("git", root_path, &["status", "--porcelain", "-uno"]).map(|s| !s.is_empty());
        ctx.github = run("git", root_path, &["remote", "get-url", "origin"]).and_then(|r| github_of(&r));
        ctx.ticket = ctx.branch.as_deref().and_then(ticket_of);
        ctx.repo_root = Some(root);
    }

    ctx.herdr_workspace = non_empty(std::env::var("HERDR_WORKSPACE_ID").ok());
    ctx.herdr_tab = non_empty(std::env::var("HERDR_TAB_ID").ok());
    ctx.herdr_pane = non_empty(std::env::var("HERDR_PANE_ID").ok());
    if let Some(workspace) = ctx.herdr_workspace.clone() {
        gather_herdr(&mut ctx, &workspace, cwd);
    }
    if ctx.session_id.is_none() {
        if let Some(id) = non_empty(std::env::var("CLAUDE_CODE_SESSION_ID").ok()) {
            ctx.agent.get_or_insert_with(|| "claude".into());
            ctx.session_id = Some(id);
        }
    }
    ctx
}

/// The tab's label, and the pane's chat title and agent session, as herdr reports them.
fn gather_herdr(ctx: &mut Context, workspace: &str, cwd: &Path) {
    let read = |args: &[&str]| -> Option<Value> {
        serde_json::from_str(&run("herdr", cwd, args)?).ok()
    };
    if let (Some(tab), Some(tabs)) = (ctx.herdr_tab.clone(), read(&["tab", "list", "--workspace", workspace])) {
        let found = tabs["result"]["tabs"].as_array().into_iter().flatten().find(|t| t["tab_id"] == tab.as_str());
        ctx.herdr_tab_label = found.and_then(|t| t["label"].as_str()).map(str::to_string);
    }
    if let (Some(pane), Some(panes)) = (ctx.herdr_pane.clone(), read(&["pane", "list", "--workspace", workspace])) {
        if let Some(p) = panes["result"]["panes"].as_array().into_iter().flatten().find(|p| p["pane_id"] == pane.as_str()) {
            ctx.chat_title = non_empty(p["terminal_title_stripped"].as_str().map(str::to_string));
            ctx.agent = p["agent"].as_str().map(str::to_string);
            ctx.session_id = p["agent_session"]["value"].as_str().map(str::to_string);
        }
    }
}
