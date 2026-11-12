//! `E`: open a file in nvim in a new Rex tab and go there. The command is
//! typed into the tab's shell, as `C` does, so quitting nvim lands on a prompt
//! in the repo.

use std::path::Path;

use crate::agent;

/// What the tab runs, from the repo root. `--` so a path can't read as a flag.
pub fn command(rel: &str, line: u32) -> String {
    format!("nvim +{line} -- '{}'", rel.replace('\'', r"'\''"))
}

pub fn open(root: &Path, rel: &str, line: u32) -> Result<(), String> {
    let label = agent::snake(rel.rsplit('/').next().unwrap_or(rel));
    agent::new_tab(&root.to_string_lossy(), &label, true, &format!("{}\n", command(rel, line)))
        .map_err(|e| format!("couldn't open a tab: {e}"))
}
