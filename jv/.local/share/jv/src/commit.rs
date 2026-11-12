//! `C`: commit and push everything in a new Rex tab, the way the `x` shell
//! function does (git add, commit -m changes --no-verify, push). The tab
//! closes itself once the push lands and stays open on whatever failed, so
//! the error is there to read. jv stays where it is.

use std::path::Path;
use std::process::{Command, ExitCode, Stdio};
use std::sync::mpsc;

use crate::agent;

/// Internal: `jv --commit CWD` does the Rex call. A separate process, so
/// quitting jv right after `C` still gets the tab its command.
pub const CHILD_FLAG: &str = "--commit";

const LABEL: &str = "commit";

/// What the tab runs, typed into its shell so it shows there (the shell reads
/// it once it's up). `$REX_BLOCK` is the new tab's one pane: closing it
/// closes the tab.
pub const SCRIPT: &str =
    r#"git add -A && git commit -m changes --no-verify && git push && rex block close -s "$REX_SESSION" "$REX_BLOCK""#;

/// Commit and push the repo at `root` in the background. The outcome comes
/// back on `tx` as a status-bar line.
pub fn spawn(root: &Path, tx: mpsc::Sender<String>) {
    agent::background(vec![CHILD_FLAG.into(), root.into()], "the commit tab".into(), tx);
}

/// The `--commit` process: one line on stdout says how it went.
pub fn child(args: &[String]) -> ExitCode {
    let [root] = args else { return ExitCode::from(2) };
    agent::report(start(Path::new(root)))
}

fn start(root: &Path) -> Result<String, String> {
    // A clean tree would only leave a tab open on "nothing to commit".
    let st = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(root)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if !st.status.success() {
        return Err(format!("{} isn't a git repo", root.display()));
    }
    if st.stdout.is_empty() {
        return Ok("nothing to commit".into());
    }
    agent::new_tab(&root.to_string_lossy(), LABEL, false, &format!("{SCRIPT}\n")).map_err(|e| format!("couldn't open a tab: {e}"))?;
    Ok(format!("committing & pushing in tab {LABEL} · it closes once pushed"))
}
