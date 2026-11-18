//! jn (`jv --net`): the PRs ticked in the list, merged onto the repo's default
//! branch one after another, and the diff of that result against the branch:
//! what the branch would gain if every ticked PR landed.
//!
//! It's all `git merge-tree` and `git commit-tree` in this checkout: nothing
//! is checked out, no ref moves, and the commits it makes are loose objects
//! that `git gc` drops. Each merge finds its own merge base, so a stacked PR
//! only adds its own commits on top of the PR below it.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::Value;

use crate::prs::{self, Pr};

/// What `jn` was asked for: a PR search (always open PRs in this repo) and
/// PRs named by number.
pub struct Args {
    pub query: prs::Query,
    pub numbers: Vec<u32>,
}

impl Args {
    pub fn parse(args: &[String]) -> Result<Args, String> {
        let mut rest = Vec::new();
        let mut numbers = Vec::new();
        for a in args {
            match a.as_str() {
                "-a" | "--all" | "--all-repos" | "-R" | "--repo" => {
                    return Err(format!("{a}: jn merges PRs in this checkout, so it only lists this repo's"))
                }
                "-o" | "--open" => {}
                s => match s.trim_start_matches('#').parse::<u32>() {
                    Ok(n) if !s.starts_with('-') => numbers.push(n),
                    _ => rest.push(a.clone()),
                },
            }
        }
        let mut query = prs::Query::parse(&rest)?;
        query.open = true;
        if query.repo.is_none() {
            return Err("run jn inside a checkout of a GitHub repo".into());
        }
        Ok(Args { query, numbers })
    }
}

/// The branch every ticked PR is merged onto.
#[derive(Clone, Debug)]
pub struct Base {
    pub name: String,
    pub oid: String,
}

/// One ticked PR, as the merge needs it.
#[derive(Clone, Debug)]
pub struct Pick {
    pub number: u32,
    pub oid: String,
    pub head: String,
    pub base: String,
}

impl Pick {
    pub fn of(pr: &Pr) -> Pick {
        Pick { number: pr.number, oid: pr.head_oid.clone(), head: pr.head.clone(), base: pr.base.clone() }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Net {
    pub text: String,
    /// The PRs merged, in the order they went in (stack bottoms first).
    pub order: Vec<u32>,
    /// Each path a PR changes (its side of the merge) → those PRs, in order.
    pub touched: HashMap<String, Vec<u32>>,
    /// PRs whose merge conflicted, and where. Their markers stay in the diff.
    pub conflicts: Vec<(u32, Vec<String>)>,
    /// PRs left out, and why.
    pub skipped: Vec<(u32, String)>,
}

impl Net {
    pub fn conflicted(&self, n: u32) -> Option<&[String]> {
        self.conflicts.iter().find(|(c, _)| *c == n).map(|(_, f)| f.as_slice())
    }

    pub fn skip_reason(&self, n: u32) -> Option<&str> {
        self.skipped.iter().find(|(c, _)| *c == n).map(|(_, r)| r.as_str())
    }

    /// Paths with conflict markers in them.
    pub fn conflict_paths(&self) -> HashSet<&str> {
        self.conflicts.iter().flat_map(|(_, f)| f.iter().map(String::as_str)).collect()
    }
}

/// PRs by number, for `jn 123 456`: whoever wrote them, whatever their state.
pub fn by_numbers(repo: &str, numbers: &[u32]) -> Result<Vec<Pr>, String> {
    if numbers.is_empty() {
        return Ok(Vec::new());
    }
    let (owner, name) = repo.split_once('/').ok_or_else(|| format!("bad repo {repo}"))?;
    let fields: String =
        numbers.iter().map(|n| format!("p{n}: pullRequest(number: {n}) {{ {} }} ", prs::FIELDS)).collect();
    let gql = format!("query($owner: String!, $name: String!) {{ repository(owner: $owner, name: $name) {{ {fields} }} }}");
    let out = Command::new("gh")
        .args(["api", "graphql", "-f"])
        .arg(format!("query={gql}"))
        .arg("-f")
        .arg(format!("owner={owner}"))
        .arg("-f")
        .arg(format!("name={name}"))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("gh: {e}"))?;
    let v: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
    if !out.status.success() && v["data"].is_null() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("gh api graphql exited with {}", out.status) } else { err });
    }
    let mut found = Vec::new();
    let mut lost = Vec::new();
    for n in numbers {
        match prs::parse_pr(&v["data"]["repository"][format!("p{n}")], false) {
            Some(pr) => found.push(pr),
            None => lost.push(format!("#{n}")),
        }
    }
    if !lost.is_empty() {
        return Err(format!("no PR {} in {repo}", lost.join(", ")));
    }
    Ok(found)
}

/// origin's default branch and its tip, straight from the remote.
pub fn default_branch() -> Result<Base, String> {
    let out = git(&["ls-remote", "--symref", "origin", "HEAD"])?;
    let mut name = None;
    let mut oid = None;
    for l in out.lines() {
        if let Some(r) = l.strip_prefix("ref: ") {
            name = r.split('\t').next().and_then(|r| r.strip_prefix("refs/heads/")).map(str::to_string);
        } else if let Some((o, "HEAD")) = l.split_once('\t') {
            oid = Some(o.to_string());
        }
    }
    match (name, oid) {
        (Some(name), Some(oid)) => Ok(Base { name, oid }),
        _ => Err("couldn't read origin's default branch (git ls-remote --symref origin HEAD)".into()),
    }
}

pub fn remote_branch(name: &str) -> Result<Base, String> {
    let reference = format!("refs/heads/{name}");
    let out = git(&["ls-remote", "--exit-code", "origin", &reference])?;
    let oid = out.lines().find_map(|line| {
        let (oid, found) = line.split_once('\t')?;
        (found == reference).then(|| oid.to_string())
    }).ok_or_else(|| format!("couldn't read origin/{name}"))?;
    Ok(Base { name: name.to_string(), oid })
}

/// Stack bottoms first: a PR whose base branch is another pick's head goes
/// in after that pick. Otherwise oldest (lowest number) first.
pub fn order(picks: &[Pick], base: &str) -> Vec<Pick> {
    let by_head: HashMap<&str, usize> =
        picks.iter().enumerate().filter(|(_, p)| p.head != base).map(|(i, p)| (p.head.as_str(), i)).collect();
    let depth = |mut i: usize| {
        let mut seen = HashSet::from([i]);
        let mut d = 0;
        while let Some(&j) = by_head.get(picks[i].base.as_str()) {
            if !seen.insert(j) {
                break;
            }
            d += 1;
            i = j;
        }
        d
    };
    let mut v: Vec<(usize, Pick)> = picks.iter().enumerate().map(|(i, p)| (depth(i), p.clone())).collect();
    v.sort_by_key(|(d, p)| (*d, p.number));
    v.into_iter().map(|(_, p)| p).collect()
}

/// Merge `picks` onto `base` and diff the result against it. `go(k)` is
/// called before the k-th merge (0 while fetching); false stops the work
/// and gives None.
pub fn compute(base: &Base, picks: &[Pick], go: &dyn Fn(usize) -> bool) -> Result<Option<Net>, String> {
    if !go(0) {
        return Ok(None);
    }
    let missing = ensure_commits(base, picks)?;
    compute_in_order(base, &order(picks, &base.name), &missing, go)
}

/// Apply the stack in its registered order. If a later head already contains
/// an earlier one, merging the earlier head separately can create a conflict
/// on an edit that the later PR reverted. Apply only the independent heads.
pub fn compute_stack(base: &Base, picks: &[Pick]) -> Result<Net, String> {
    let missing = ensure_commits(base, picks)?;
    if let Some(p) = picks.iter().find(|p| missing.contains(&p.oid)) {
        return Err(format!("couldn't fetch the head of #{}", p.number));
    }
    if picks.is_empty() {
        return Ok(Net::default());
    }
    let mut args = vec!["merge-base", "--independent"];
    args.extend(picks.iter().map(|p| p.oid.as_str()));
    let independent = git(&args)?;
    let mut tips: HashSet<&str> = independent.lines().collect();
    let mut heads: Vec<Pick> = picks.iter().rev().filter(|p| tips.remove(p.oid.as_str())).cloned().collect();
    heads.reverse();
    let net = compute_in_order(base, &heads, &missing, &|_| true)?.expect("stack computation is never cancelled");
    if let Some((number, reason)) = net.skipped.first() {
        return Err(format!("couldn't include #{number}: {reason}"));
    }
    Ok(net)
}

fn ensure_commits(base: &Base, picks: &[Pick]) -> Result<HashSet<String>, String> {
    // Every commit has to be here; fetch the ones that aren't, in one go.
    let want: Vec<&str> = std::iter::once(base.oid.as_str()).chain(picks.iter().map(|p| p.oid.as_str())).collect();
    let mut missing = missing_commits(&want)?;
    if !missing.is_empty() {
        let mut specs = Vec::new();
        if missing.contains(&base.oid) {
            specs.push(format!("refs/heads/{}", base.name));
        }
        specs.extend(picks.iter().filter(|p| missing.contains(&p.oid)).map(|p| format!("refs/pull/{}/head", p.number)));
        let mut args = vec!["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--refmap=", "origin"];
        args.extend(specs.iter().map(String::as_str));
        git(&args)?;
        missing = missing_commits(&want)?;
    }
    if missing.contains(&base.oid) {
        return Err(format!("{} ({}) isn't in this checkout and fetching it failed", base.name, short(&base.oid)));
    }
    Ok(missing)
}

fn compute_in_order(base: &Base, picks: &[Pick], missing: &HashSet<String>, go: &dyn Fn(usize) -> bool) -> Result<Option<Net>, String> {
    let mut net = Net::default();
    let mut cur = base.oid.clone();
    let mut labels: Vec<(String, String)> = vec![(base.oid.clone(), base.name.clone())];
    for (k, p) in picks.iter().enumerate() {
        if !go(k + 1) {
            return Ok(None);
        }
        if missing.contains(&p.oid) {
            net.skipped.push((p.number, "its head commit couldn't be fetched (R refreshes the list)".into()));
            continue;
        }
        // What this PR brings, from where it and the merge so far part ways.
        let names = git(&["-c", "core.quotepath=off", "diff", "--name-only", &format!("{cur}...{}", p.oid)])?;
        let (code, out) = git_code(&["-c", "core.quotepath=off", "merge-tree", "--write-tree", "--name-only", "--no-messages", &cur, &p.oid])?;
        if code > 1 {
            net.skipped.push((p.number, format!("git merge-tree failed: {}", out.lines().next().unwrap_or(""))));
            continue;
        }
        let mut lines = out.lines();
        let tree = lines.next().unwrap_or("").to_string();
        if code == 1 {
            net.conflicts.push((p.number, lines.take_while(|l| !l.is_empty()).map(str::to_string).collect()));
        }
        for path in names.lines().filter(|l| !l.is_empty()) {
            net.touched.entry(path.to_string()).or_default().push(p.number);
        }
        let msg = format!("jn: merge #{}", p.number);
        let commit = git_commit(&["commit-tree", "--no-gpg-sign", &tree, "-p", &cur, "-p", &p.oid, "-m", &msg])?;
        net.order.push(p.number);
        labels.push((p.oid.clone(), format!("#{} {}", p.number, p.head)));
        let so_far: Vec<String> = net.order.iter().map(|n| format!("#{n}")).collect();
        labels.push((commit.clone(), format!("{} + {}", base.name, so_far.join(" "))));
        cur = commit;
    }
    let text = git(&["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", &base.oid, &cur])?;
    net.text = relabel(&text, &labels);
    Ok(Some(net))
}

/// merge-tree names each side of a conflict by the commit it was given; put
/// the PR (or the merge so far) there instead of a hash.
fn relabel(text: &str, labels: &[(String, String)]) -> String {
    if !text.contains("+<<<<<<< ") {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let marker = ["+<<<<<<< ", "+>>>>>>> ", "+||||||| "].iter().find(|m| line.starts_with(*m));
        let Some(m) = marker else {
            out.push_str(line);
            continue;
        };
        let rest = &line[m.len()..];
        let word = rest.split([':', ' ', '\n']).next().unwrap_or("");
        let hex = word.len() >= 7 && word.bytes().all(|b| b.is_ascii_hexdigit());
        let known = labels.iter().find(|(oid, _)| hex && oid.starts_with(word)).map(|(_, l)| l.as_str());
        // diff3 / zdiff3 name the common ancestor by an abbreviated hash.
        let label = known.or((hex && *m == "+||||||| ").then_some("merge base"));
        match label {
            Some(l) => {
                out.push_str(m);
                out.push_str(l);
                out.push_str(&rest[word.len()..]);
            }
            None => out.push_str(line),
        }
    }
    out
}

fn short(oid: &str) -> &str {
    &oid[..oid.len().min(10)]
}

/// The commits of `oids` this repo doesn't have.
fn missing_commits(oids: &[&str]) -> Result<HashSet<String>, String> {
    let mut child = Command::new("git")
        .args(["cat-file", "--batch-check=%(objectname) %(objecttype)"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        for o in oids {
            let _ = writeln!(stdin, "{o}");
        }
    }
    let out = child.wait_with_output().map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let have: HashSet<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.strip_suffix(" commit"))
        .map(str::to_string)
        .collect();
    Ok(oids.iter().filter(|o| !o.is_empty() && !have.contains(**o)).map(|o| o.to_string()).collect())
}

fn git(args: &[&str]) -> Result<String, String> {
    match git_code(args)? {
        (0, out) => Ok(out),
        (_, err) => Err(err),
    }
}

/// Exit code and stdout; stderr instead when git failed outright.
fn git_code(args: &[&str]) -> Result<(i32, String), String> {
    run(Command::new("git").args(args))
}

/// commit-tree needs a name and email, and a machine may have neither set.
fn git_commit(args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args);
    for (k, v) in [
        ("GIT_AUTHOR_NAME", "jn"),
        ("GIT_AUTHOR_EMAIL", "jn@localhost"),
        ("GIT_COMMITTER_NAME", "jn"),
        ("GIT_COMMITTER_EMAIL", "jn@localhost"),
    ] {
        cmd.env(k, v);
    }
    match run(&mut cmd)? {
        (0, out) => Ok(out.trim().to_string()),
        (_, err) => Err(err),
    }
}

fn run(cmd: &mut Command) -> Result<(i32, String), String> {
    let out = cmd.stdin(Stdio::null()).output().map_err(|e| format!("git: {e}"))?;
    let code = out.status.code().unwrap_or(-1);
    // 1 with output is merge-tree's "merged, with conflicts"; anything else
    // but 0 is a failure.
    if code != 0 && !(code == 1 && !out.stdout.is_empty()) {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        let what = args.iter().find(|a| !a.starts_with('-') && !a.contains('=')).cloned().unwrap_or_default();
        return Ok((code.max(2), if err.is_empty() { format!("git {what} exited with {}", out.status) } else { err }));
    }
    Ok((code, String::from_utf8_lossy(&out.stdout).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick(n: u32, head: &str, base: &str) -> Pick {
        Pick { number: n, oid: String::new(), head: head.into(), base: base.into() }
    }

    #[test]
    fn stacks_go_bottom_first() {
        let picks = [pick(30, "c", "b"), pick(10, "x", "main"), pick(25, "b", "a"), pick(40, "a", "main")];
        let got: Vec<u32> = order(&picks, "main").iter().map(|p| p.number).collect();
        assert_eq!(got, vec![10, 40, 25, 30]);
    }

    #[test]
    fn a_fork_named_main_isnt_a_stack() {
        let picks = [pick(2, "main", "main"), pick(1, "feat", "main")];
        let got: Vec<u32> = order(&picks, "main").iter().map(|p| p.number).collect();
        assert_eq!(got, vec![1, 2]);
    }

    #[test]
    fn markers_get_pr_labels() {
        let labels = vec![
            ("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(), "main + #1".to_string()),
            ("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(), "#2 feat".to_string()),
        ];
        let text = "+<<<<<<< aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n+x\n+||||||| ebf3da523ad\n+=======\n+y\n+>>>>>>> bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:src/a.rs\n ctx\n";
        assert_eq!(
            relabel(text, &labels),
            "+<<<<<<< main + #1\n+x\n+||||||| merge base\n+=======\n+y\n+>>>>>>> #2 feat:src/a.rs\n ctx\n"
        );
    }

    #[test]
    fn args() {
        let a = Args::parse(&["#12".into(), "34".into(), "-n".into(), "5".into()]);
        // Outside a GitHub checkout there's no repo to list; both are fine here.
        if let Ok(a) = a {
            assert_eq!(a.numbers, vec![12, 34]);
            assert_eq!(a.query.limit, 5);
            assert!(a.query.open);
        }
        assert!(Args::parse(&["-a".into()]).is_err());
    }
}
