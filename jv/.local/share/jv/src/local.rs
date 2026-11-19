//! jf: what landing the branch would change right now. The PR as pushed and
//! this checkout's own work (unpushed commits, staged and unstaged edits to
//! tracked files) are merged onto the base branch's current tip with git
//! merge-tree, as jn does, and the diff is taken against that tip. Edits the
//! base already has, or that later work reverts, drop out of the net diff.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::net::{self, Base, Net, Pick};
use crate::source;

/// This checkout: HEAD, plus its uncommitted edits to tracked files as one
/// loose commit on top. The edits go through a copy of the index (`git add
/// -u`), so the real index and working tree stay as they are. Untracked files
/// stay out, as in `git diff HEAD`.
pub struct Work {
    pub branch: Option<String>,
    pub head: String,
    /// HEAD itself when nothing is uncommitted.
    pub tip: String,
    pub dirty: bool,
}

pub fn snapshot() -> Result<Work, String> {
    let head = net::git(&["rev-parse", "--verify", "HEAD^{commit}"])?.trim().to_string();
    let index = net::git(&["rev-parse", "--path-format=absolute", "--git-path", "index"])?.trim().to_string();
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let scratch = Scratch(std::env::temp_dir().join(format!("jv-index-{}-{nanos}", std::process::id())));
    // Copying keeps the index's stat cache, so `add -u` only reads changed files.
    if std::fs::copy(&index, &scratch.0).is_err() {
        in_index(&scratch.0, &["read-tree", &head])?;
    }
    in_index(&scratch.0, &["add", "--update"])?;
    let tree = in_index(&scratch.0, &["write-tree"])?.trim().to_string();
    let dirty = tree != net::git(&["rev-parse", &format!("{head}^{{tree}}")])?.trim();
    let tip = if dirty {
        net::git_commit(&["commit-tree", "--no-gpg-sign", &tree, "-p", &head, "-m", "jf: local changes"])?
    } else {
        head.clone()
    };
    Ok(Work { branch: crate::app::current_branch(), head, tip, dirty })
}

/// The copied index, removed when the snapshot's done with it.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(self.0.with_extension("lock"));
    }
}

fn in_index(index: &Path, args: &[&str]) -> Result<String, String> {
    match net::run(Command::new("git").args(args).env("GIT_INDEX_FILE", index))? {
        (0, out) => Ok(out),
        (_, err) => Err(err),
    }
}

/// A pushed PR head with this checkout's work on top.
pub struct Folded {
    /// The commit that stands for the PR in the merge; None when there's
    /// nothing local, and the pushed head stands for itself.
    pub oid: Option<String>,
    /// Commits on HEAD whose changes neither the push nor the base has.
    pub unpushed: usize,
    /// Merges on HEAD the push doesn't have (bringing the base in, say).
    pub merges: usize,
    pub dirty: bool,
    /// HEAD doesn't contain the push (it's behind it, or an older copy of a
    /// branch rebased elsewhere): only the local-only commits and the edits
    /// were replayed onto the push.
    pub replayed: bool,
    /// Paths where that replay conflicted; their markers stay in.
    pub conflicts: Vec<String>,
    /// Names for the replay's commits in conflict markers.
    pub labels: Vec<(String, String)>,
}

/// This checkout's work on top of `pushed`, for a merge onto `base` (both
/// already in this repo). A branch that contains the push is HEAD plus its
/// edits. Otherwise HEAD's commits that the push and the base lack (by patch,
/// so an older copy of a rebased branch adds nothing) and the edits are
/// cherry-picked onto the push in memory.
pub fn fold_onto(work: &Work, pushed: &str, base: &str, name: &str) -> Result<Folded, String> {
    let not_base = format!("^{base}");
    let mut f = Folded {
        oid: None,
        unpushed: 0,
        merges: 0,
        dirty: work.dirty,
        replayed: false,
        conflicts: Vec::new(),
        labels: Vec::new(),
    };
    if work.head == pushed || is_ancestor(pushed, &work.head)? {
        let range = format!("{pushed}..{}", work.head);
        f.unpushed = count(&["--no-merges", &range, &not_base])?;
        f.merges = count(&["--merges", &range, &not_base])?;
        // A merge's conflict resolutions count, so any new commit goes in.
        f.oid = (work.head != pushed || work.dirty).then(|| work.tip.clone());
        return Ok(f);
    }
    // Patches the push lacks (matched against everything on its side, base
    // commits included), less commits the base already has.
    let range = format!("{pushed}...{}", work.head);
    let out = net::git(&["rev-list", "--reverse", "--cherry-pick", "--right-only", "--no-merges", &range])?;
    let fresh = net::git(&["rev-list", "--no-merges", &format!("{pushed}..{}", work.head), &not_base])?;
    let fresh: std::collections::HashSet<&str> = fresh.lines().collect();
    let commits: Vec<&str> = out.lines().filter(|l| fresh.contains(l)).collect();
    f.unpushed = commits.len();
    f.replayed = true;
    if commits.is_empty() && !work.dirty {
        return Ok(f);
    }
    f.labels.push((pushed.to_string(), format!("{name} as pushed")));
    let mut cur = pushed.to_string();
    for c in commits {
        cur = replay(&mut f, &format!("{c}^"), c, &cur)?;
        f.labels.push((c.to_string(), format!("local {}", net::short(c))));
        f.labels.push((cur.clone(), format!("{name} + local")));
    }
    if work.dirty {
        cur = replay(&mut f, &work.head, &work.tip, &cur)?;
        f.labels.push((work.tip.clone(), "uncommitted changes".into()));
    }
    f.oid = Some(cur);
    Ok(f)
}

/// Cherry-pick `from..to` onto `onto` without touching the checkout.
fn replay(f: &mut Folded, from: &str, to: &str, onto: &str) -> Result<String, String> {
    let base = format!("--merge-base={from}");
    let (code, out) = net::git_code(&[
        "-c", "core.quotepath=off", "merge-tree", "--write-tree", "--name-only", "--no-messages", &base, onto, to,
    ])?;
    if code > 1 {
        return Err(format!("replaying local work: {}", first_line(&out)));
    }
    let mut lines = out.lines();
    let tree = lines.next().unwrap_or("").to_string();
    if code == 1 {
        for path in lines.take_while(|l| !l.is_empty()) {
            if !f.conflicts.iter().any(|c| c == path) {
                f.conflicts.push(path.to_string());
            }
        }
    }
    net::git_commit(&["commit-tree", "--no-gpg-sign", &tree, "-p", onto, "-m", "jf: local work replayed"])
}

impl Folded {
    /// "+ local: 2 unpushed commits, uncommitted changes", or what the
    /// checkout is when nothing local went in.
    pub fn describe(&self) -> String {
        let mut parts = Vec::new();
        if self.unpushed > 0 {
            parts.push(format!("{} unpushed commit{}", self.unpushed, plural(self.unpushed)));
        }
        if self.merges > 0 {
            parts.push(format!("{} unpushed merge{}", self.merges, plural(self.merges)));
        }
        if self.dirty {
            parts.push("uncommitted changes".to_string());
        }
        let mut s = if self.oid.is_none() {
            "nothing local".to_string()
        } else {
            format!("+ local: {}", parts.join(", "))
        };
        if self.replayed {
            s.push_str(if self.oid.is_none() { " (checkout is behind the push)" } else { ", replayed onto the push" });
        }
        if !self.conflicts.is_empty() {
            let n = self.conflicts.len();
            s.push_str(&format!(" · ⚠ local work conflicts with the push in {n} file{}", plural(n)));
        }
        s
    }

    /// The pick for the merge: this work when there is some, else the push.
    pub fn pick(&self, pushed: Pick) -> Pick {
        match &self.oid {
            Some(oid) => Pick { oid: oid.clone(), local: true, ..pushed },
            None => pushed,
        }
    }
}

/// jf --stack: the checked-out PR's entry becomes this checkout's work.
pub fn fold_stack(base: &Base, mut picks: Vec<Pick>, work: &Work) -> Result<(Vec<Pick>, Option<Folded>), String> {
    let Some(i) = picks.iter().position(|p| work.branch.as_deref() == Some(p.head.as_str())) else {
        return Ok((picks, None));
    };
    let missing = net::ensure_commits(base, &picks)?;
    if missing.contains(&picks[i].oid) {
        return Err(format!("couldn't fetch the head of #{}", picks[i].number));
    }
    let folded = fold_onto(work, &picks[i].oid, &base.oid, &format!("#{}", picks[i].number))?;
    picks[i] = folded.pick(picks[i].clone());
    Ok((picks, Some(folded)))
}

/// The diff `jf` shows, and the header's note on what went into it. Anything
/// that can't be merged here (gh flags, another repo's PR, a closed PR) is
/// GitHub's diff, as before.
pub fn fetch(args: &[String]) -> Result<(String, Option<String>), String> {
    let selector = match args {
        [] => None,
        [s] if !s.starts_with('-') => Some(s.as_str()),
        _ => return source::load("pr", args),
    };
    let work = thread::spawn(snapshot);
    let pr = view(selector);
    let work = work.join().unwrap_or_else(|_| Err("the local snapshot stopped".into()));
    let pr = match pr {
        Ok(pr) => pr,
        Err(e) if selector.is_none() && (e.contains("no pull requests found") || work.as_ref().is_ok_and(|w| w.branch.is_none())) => {
            return match work {
                Ok(w) => no_pr(&w).or_else(|err| {
                    let (text, _) = source::load("local", &[])?;
                    Ok((text, Some(format!("no PR · local changes (git diff HEAD) · no net: {}", first_line(&err)))))
                }),
                Err(_) => Err(e),
            };
        }
        Err(e) => return Err(e),
    };
    let here = crate::prs::this_repo().is_some_and(|r| {
        pr.url.to_ascii_lowercase().starts_with(&format!("https://github.com/{}/pull/", r.to_ascii_lowercase()))
    });
    if pr.state != "OPEN" || !here {
        return source::load("pr", args);
    }
    match pr_net(&pr, work) {
        Ok(found) => Ok(found),
        Err(e) => {
            let (text, _) = source::load("pr", args)?;
            Ok((text, Some(format!("⚠ GitHub's diff, no net: {}", first_line(&e)))))
        }
    }
}

struct Pr {
    number: u32,
    state: String,
    head: String,
    head_oid: String,
    base: String,
    cross: bool,
    url: String,
}

fn view(selector: Option<&str>) -> Result<Pr, String> {
    let mut cmd = Command::new("gh");
    cmd.args(["pr", "view"]);
    cmd.args(selector);
    cmd.args(["--json", "number,state,headRefName,headRefOid,baseRefName,isCrossRepository,url"]);
    let out = cmd.stdin(Stdio::null()).output().map_err(|e| format!("gh: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("gh pr view exited with {}", out.status) } else { err });
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("gh pr view: {e}"))?;
    let text = |k: &str| v[k].as_str().map(str::to_string).ok_or_else(|| format!("gh pr view: no {k}"));
    Ok(Pr {
        number: v["number"].as_u64().ok_or("gh pr view: no number")? as u32,
        state: text("state")?,
        head: text("headRefName")?,
        head_oid: text("headRefOid")?,
        base: text("baseRefName")?,
        cross: v["isCrossRepository"].as_bool().unwrap_or(false),
        url: text("url")?,
    })
}

/// The PR merged onto its base branch's tip. When it's the checked-out
/// branch's PR, this checkout's work goes in with it (or instead of it).
fn pr_net(pr: &Pr, work: Result<Work, String>) -> Result<(String, Option<String>), String> {
    let mut base = net::remote_branch(&pr.base)?;
    let pushed = Pick {
        number: pr.number,
        oid: pr.head_oid.clone(),
        head: pr.head.clone(),
        base: pr.base.clone(),
        local: false,
    };
    let mine = !pr.cross && work.as_ref().is_ok_and(|w| w.branch.as_deref() == Some(pr.head.as_str()));
    if !mine {
        let net = net::merge(&base, &[pushed])?;
        return Ok((net.text.clone(), Some(badge("net · not checked out here".into(), &net))));
    }
    let work = work?;
    let missing = net::ensure_commits(&base, std::slice::from_ref(&pushed))?;
    if missing.contains(&pushed.oid) {
        return Err(format!("couldn't fetch the head of #{}", pr.number));
    }
    let folded = fold_onto(&work, &pushed.oid, &base.oid, &format!("#{}", pr.number))?;
    let mut what = match folded.oid {
        Some(_) => format!("net {}", folded.describe()),
        None => format!("net · {}", folded.describe()),
    };
    // A base branch with unpushed commits that this branch is built on (a
    // stack restacked here): diff against it, so its commits don't count as
    // this PR's.
    if !folded.replayed {
        if let Some(oid) = local_ahead(&base, &work.head)? {
            base.oid = oid;
            what.push_str(&format!(" · onto local {}", base.name));
        }
    }
    let mut net = net::merge(&base, &[folded.pick(pushed)])?;
    net.text = net::relabel(&net.text, &folded.labels);
    Ok((net.text.clone(), Some(badge(what, &net))))
}

/// No PR for this branch: its commits and uncommitted edits, merged onto
/// origin's default branch.
fn no_pr(work: &Work) -> Result<(String, Option<String>), String> {
    let base = net::default_branch()?;
    let name = work.branch.clone().unwrap_or_else(|| "HEAD".into());
    let pick = Pick { number: 0, oid: work.tip.clone(), head: name.clone(), base: base.name.clone(), local: true };
    let net = net::merge(&base, &[pick])?;
    let ahead = count(&["--no-merges", &format!("{}..{}", base.oid, work.head)])?;
    let mut parts = Vec::new();
    if ahead > 0 {
        parts.push(format!("{ahead} commit{} not on {}", plural(ahead), base.name));
    }
    if work.dirty {
        parts.push("uncommitted changes".to_string());
    }
    let mut what = format!("no PR · net of {name} onto {}", base.name);
    if !parts.is_empty() {
        what = format!("{what}: {}", parts.join(", "));
    }
    Ok((net.text.clone(), Some(badge(what, &net))))
}

fn badge(mut what: String, net: &Net) -> String {
    let n = net.conflict_paths().len();
    if n > 0 {
        what.push_str(&format!(" · ⚠ conflicts in {n} file{}", plural(n)));
    }
    what
}

/// The local branch named like `base`, when it's ahead of origin's and
/// `head` is built on it.
fn local_ahead(base: &Base, head: &str) -> Result<Option<String>, String> {
    let Ok(oid) = net::git(&["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}^{{commit}}", base.name)]) else {
        return Ok(None);
    };
    let oid = oid.trim().to_string();
    if oid == base.oid || !is_ancestor(&base.oid, &oid)? || !is_ancestor(&oid, head)? {
        return Ok(None);
    }
    Ok(Some(oid))
}

fn is_ancestor(a: &str, b: &str) -> Result<bool, String> {
    let out = Command::new("git")
        .args(["merge-base", "--is-ancestor", a, b])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("git: {e}"))?;
    match out.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
    }
}

fn count(args: &[&str]) -> Result<usize, String> {
    let mut all = vec!["rev-list", "--count"];
    all.extend_from_slice(args);
    net::git(&all)?.trim().parse().map_err(|e| format!("git rev-list --count: {e}"))
}

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or("")
}
