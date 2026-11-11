//! `jp` (`jv --prs`): the pull requests the left pane lists. One GitHub search
//! (GraphQL, through `gh api`) finds them; each one's diff then comes from
//! `gh pr diff -R repo N`, like plain jv.

use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

/// Search qualifiers that say whose PRs these are. With none of them in the
/// terms, the search is `author:@me`.
const WHO: [&str; 8] =
    ["author:", "assignee:", "involves:", "mentions:", "commenter:", "review-requested:", "reviewed-by:", "user-review-requested:"];

const DEFAULT_LIMIT: usize = 40;

pub const HELP: &str = "\
jp — your recent PRs on the left, the selected one's diff on the right

usage:
  jp [search terms]      your PRs in this repo, most recently updated first
                         (terms are GitHub search: is:open, label:bug, juno …;
                          review-requested:@me lists PRs waiting on you instead)
  -o, --open             open PRs only
  -a, --all              every repo, not just this one
  -R, --repo OWNER/REPO  that repo instead of this one
  -n N                   how many (default 40, at most 100)

jv's options work too (-s, -u, --no-wrap, --tests, --theme). Inside, press ?
for keys: j/k pick a PR, ⏎ opens its files, - goes back, tab moves to the diff.
";

#[derive(Clone, Debug, Default)]
pub struct Query {
    /// owner/name; None searches every repo.
    pub repo: Option<String>,
    pub open: bool,
    pub limit: usize,
    pub terms: Vec<String>,
}

impl Query {
    /// The words after `jp` (what jv didn't take for itself).
    pub fn parse(args: &[String]) -> Result<Query, String> {
        let mut q = Query { limit: DEFAULT_LIMIT, ..Query::default() };
        let mut all = false;
        let mut it = args.iter();
        while let Some(a) = it.next() {
            match a.as_str() {
                "-o" | "--open" => q.open = true,
                "-a" | "--all" | "--all-repos" => all = true,
                "-R" | "--repo" => q.repo = Some(it.next().ok_or("-R needs OWNER/REPO")?.clone()),
                "-n" | "--limit" => {
                    let n = it.next().ok_or("-n needs a number")?;
                    q.limit = n.parse::<usize>().map_err(|_| format!("-n: {n} isn't a number"))?.clamp(1, 100);
                }
                s if s.starts_with("--repo=") => q.repo = Some(s["--repo=".len()..].to_string()),
                s if s.starts_with('-') => return Err(format!("unknown option {s} (jp -h lists them)")),
                s => q.terms.push(s.to_string()),
            }
        }
        if q.repo.is_none() && !all {
            q.repo = this_repo();
        }
        Ok(q)
    }

    fn names_who(&self) -> bool {
        self.terms.iter().any(|t| WHO.iter().any(|w| t.trim_start_matches('-').starts_with(w)))
    }

    /// The GitHub search string.
    pub fn search(&self) -> String {
        let mut s = vec!["is:pr".to_string(), "sort:updated-desc".to_string()];
        if let Some(r) = &self.repo {
            s.push(format!("repo:{r}"));
        }
        if !self.names_who() {
            s.push("author:@me".into());
        }
        if self.open {
            s.push("is:open".into());
        }
        s.extend(self.terms.iter().cloned());
        s.join(" ")
    }

    /// What the list's header says it shows: `Your PRs · tax-holiday · open`.
    pub fn label(&self) -> String {
        let mut parts = Vec::new();
        if !self.names_who() {
            parts.push("Your PRs".to_string());
        }
        parts.extend(self.terms.iter().cloned());
        parts.push(match &self.repo {
            Some(r) => r.rsplit('/').next().unwrap_or(r).to_string(),
            None => "all repos".into(),
        });
        if self.open {
            parts.push("open".into());
        }
        parts.join(" · ")
    }
}

#[derive(Clone, Debug, Default)]
pub struct Pr {
    pub repo: String,
    pub number: u32,
    pub title: String,
    /// OPEN, MERGED or CLOSED.
    pub state: String,
    pub draft: bool,
    pub url: String,
    /// Seconds since the epoch.
    pub updated: i64,
    pub head: String,
    pub base: String,
    pub author: String,
    pub adds: usize,
    pub dels: usize,
    pub files: usize,
    /// APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or empty.
    pub review: String,
    /// The head commit's check rollup: SUCCESS, FAILURE, ERROR, PENDING,
    /// EXPECTED. None until the slower search that asks for it comes back.
    pub ci: Option<String>,
}

impl Pr {
    /// Unique across repos: the cache and the per-PR view state key off it.
    pub fn key(&self) -> String {
        format!("{}#{}", self.repo, self.number)
    }

    /// What the `/` filter looks through.
    pub fn haystack(&self) -> String {
        let state = if self.draft { "draft" } else { &self.state };
        format!("{} {} #{} {} {} @{}", self.title, self.head, self.number, self.repo, state.to_lowercase(), self.author)
    }

    pub fn open(&self) -> bool {
        self.state == "OPEN"
    }

    /// `gh pr diff` arguments for this PR, from anywhere.
    pub fn diff_args(&self) -> Vec<String> {
        vec![self.number.to_string(), "-R".into(), self.repo.clone()]
    }
}

const FIELDS: &str = "number title state isDraft url updatedAt headRefName baseRefName \
    additions deletions changedFiles reviewDecision author { login } repository { nameWithOwner }";
const CI: &str = "commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }";

/// Run the search. `ci` also asks for each head commit's check rollup, which
/// makes GitHub take about twice as long, so the first list goes without.
pub fn list(q: &Query, ci: bool) -> Result<Vec<Pr>, String> {
    let gql = format!(
        "query($q: String!, $n: Int!) {{ search(query: $q, type: ISSUE, first: $n) {{ nodes {{ ... on PullRequest {{ {FIELDS} {} }} }} }} }}",
        if ci { CI } else { "" }
    );
    let out = Command::new("gh")
        .args(["api", "graphql", "-f"])
        .arg(format!("query={gql}"))
        .arg("-f")
        .arg(format!("q={}", q.search()))
        .arg("-F")
        .arg(format!("n={}", q.limit))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("gh: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("gh api graphql exited with {}", out.status) } else { err });
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("gh api graphql: {e}"))?;
    if let Some(msg) = v["errors"][0]["message"].as_str() {
        return Err(msg.to_string());
    }
    let nodes = v["data"]["search"]["nodes"].as_array().cloned().unwrap_or_default();
    Ok(nodes.iter().filter_map(|n| parse_pr(n, ci)).collect())
}

fn parse_pr(n: &Value, ci: bool) -> Option<Pr> {
    let s = |k: &str| n[k].as_str().unwrap_or("").to_string();
    let u = |k: &str| n[k].as_u64().unwrap_or(0) as usize;
    let number = n["number"].as_u64()? as u32;
    let ci = ci.then(|| n["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"].as_str().unwrap_or("").to_string());
    Some(Pr {
        repo: n["repository"]["nameWithOwner"].as_str()?.to_string(),
        number,
        title: s("title"),
        state: s("state"),
        draft: n["isDraft"].as_bool().unwrap_or(false),
        url: s("url"),
        updated: parse_time(n["updatedAt"].as_str().unwrap_or("")).unwrap_or(0),
        head: s("headRefName"),
        base: s("baseRefName"),
        author: n["author"]["login"].as_str().unwrap_or("ghost").to_string(),
        adds: u("additions"),
        dels: u("deletions"),
        files: u("changedFiles"),
        review: s("reviewDecision"),
        ci: ci.filter(|c| !c.is_empty()),
    })
}

/// The GitHub repo this checkout pushes to, from its `origin` remote (no
/// network), else whatever `gh` resolves. None outside a GitHub checkout.
pub fn this_repo() -> Option<String> {
    let out = Command::new("git").args(["remote", "get-url", "origin"]).stderr(Stdio::null()).output().ok()?;
    if out.status.success() {
        if let Some(r) = parse_remote(String::from_utf8_lossy(&out.stdout).trim()) {
            return Some(r);
        }
    }
    let out = Command::new("gh")
        .args(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let r = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && r.contains('/')).then_some(r)
}

/// `git@github.com:o/r.git`, `https://github.com/o/r`, `ssh://git@github.com/o/r.git`.
fn parse_remote(url: &str) -> Option<String> {
    let i = url.find("github.com")?;
    let rest = url[i + "github.com".len()..].trim_start_matches([':', '/']).trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.splitn(3, '/');
    let (o, r) = (parts.next()?, parts.next()?);
    (!o.is_empty() && !r.is_empty()).then(|| format!("{o}/{r}"))
}

/// `2026-11-11T00:17:50Z` as seconds since the epoch.
fn parse_time(s: &str) -> Option<i64> {
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, se) = (num(11..13)?, num(14..16)?, num(17..19)?);
    // Days from civil (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + se)
}

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// `now`, `5m`, `3h`, `2d`, `6w`, `4mo`, `2y`.
pub fn age(then: i64, now: i64) -> String {
    if then == 0 {
        return String::new();
    }
    let s = (now - then).max(0);
    match s {
        s if s < 60 => "now".into(),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3600),
        s if s < 86_400 * 14 => format!("{}d", s / 86_400),
        s if s < 86_400 * 60 => format!("{}w", s / (86_400 * 7)),
        s if s < 86_400 * 365 => format!("{}mo", s / (86_400 * 30)),
        s => format!("{}y", s / (86_400 * 365)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remotes() {
        assert_eq!(parse_remote("git@github.com:NumeralHQ/tax-holiday.git").as_deref(), Some("NumeralHQ/tax-holiday"));
        assert_eq!(parse_remote("https://github.com/AceroM/dotfiles").as_deref(), Some("AceroM/dotfiles"));
        assert_eq!(parse_remote("ssh://git@github.com/o/r.git/").as_deref(), Some("o/r"));
        assert_eq!(parse_remote("https://gitlab.com/o/r"), None);
    }

    #[test]
    fn times() {
        assert_eq!(parse_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_time("2026-11-11T00:17:50Z"), Some(1_794_356_270));
        assert_eq!(age(0, 100), "");
        assert_eq!(age(1000, 1000 + 7200), "2h");
        assert_eq!(age(1000, 1000 + 86_400 * 3), "3d");
    }

    #[test]
    fn search_string() {
        let q = Query { repo: Some("o/r".into()), open: true, limit: 40, terms: vec!["juno".into()] };
        assert_eq!(q.search(), "is:pr sort:updated-desc repo:o/r author:@me is:open juno");
        assert_eq!(q.label(), "Your PRs · juno · r · open");
        let q = Query { repo: None, open: false, limit: 40, terms: vec!["review-requested:@me".into()] };
        assert_eq!(q.search(), "is:pr sort:updated-desc review-requested:@me");
        assert_eq!(q.label(), "review-requested:@me · all repos");
    }
}
