//! The registered GitHub stack containing the current branch's open PR.

use std::process::{Command, Stdio};

use serde_json::Value;

use crate::{app, net, prs};

const ENTRIES: &str = "pageInfo { hasNextPage endCursor } nodes { position pullRequest { \
    number state headRefName baseRefName headRefOid } }";

pub fn diff() -> Result<(String, String), String> {
    let branch = app::current_branch().ok_or("--stack needs a checked-out branch")?;
    // This checkout's work replaces the branch's pushed head; snapshot it
    // while GitHub answers.
    let work = std::thread::spawn(crate::local::snapshot);
    let repo = prs::this_repo().ok_or("--stack needs a GitHub checkout")?;
    let (owner, name) = repo.split_once('/').ok_or("invalid GitHub repo")?;
    let query = format!(
        "query($owner: String!, $name: String!, $branch: String!) {{
            repository(owner: $owner, name: $name) {{
                pullRequests(headRefName: $branch, states: OPEN, first: 10) {{
                    nodes {{ isCrossRepository stack {{ id number baseRefName entries(first: 100) {{ {ENTRIES} }} }} }}
                }}
            }}
        }}"
    );
    let data = graphql(
        &query,
        &[("owner", owner), ("name", name), ("branch", &branch)],
    )?;
    let stack = data["repository"]["pullRequests"]["nodes"]
        .as_array()
        .and_then(|prs| {
            prs.iter()
                .find(|pr| pr["isCrossRepository"].as_bool() == Some(false))
        })
        .map(|pr| &pr["stack"])
        .filter(|stack| !stack.is_null())
        .ok_or_else(|| format!("{branch} has no open PR in a GitHub stack"))?;
    let id = stack["id"].as_str().ok_or("GitHub stack has no id")?;
    let number = stack["number"]
        .as_u64()
        .ok_or("GitHub stack has no number")?;
    let trunk = stack["baseRefName"]
        .as_str()
        .ok_or("GitHub stack has no base branch")?;
    let picks = open_entries(id, &stack["entries"])?;
    let base = net::remote_branch(trunk)?;
    let count = picks.len();
    let (picks, local) = match work.join() {
        Ok(Ok(work)) => crate::local::fold_stack(&base, picks, &work)?,
        _ => (picks, None),
    };
    let mut net = net::compute_stack(&base, &picks)?;
    if let Some(f) = &local {
        net.text = net::relabel(&net.text, &f.labels);
    }

    let plural = if count == 1 { "" } else { "s" };
    let mut label = format!("Stack #{number} · {count} PR{plural} → {trunk}");
    // What this checkout added; a clean one that matches the push says nothing.
    if let Some(f) = local.filter(|f| f.oid.is_some() || f.replayed) {
        label.push_str(&format!(" · {}", f.describe()));
    }
    if !net.conflicts.is_empty() {
        let conflicts = net
            .conflicts
            .iter()
            .map(|(n, _)| format!("#{n}"))
            .collect::<Vec<_>>()
            .join(", ");
        label.push_str(&format!(" · ⚠ conflicts at {conflicts}"));
    }
    Ok((net.text, label))
}

fn open_entries(id: &str, first: &Value) -> Result<Vec<net::Pick>, String> {
    let mut page = first.clone();
    let mut entries = Vec::new();
    loop {
        let nodes = page["nodes"]
            .as_array()
            .ok_or("couldn't read GitHub stack entries")?;
        for node in nodes {
            let pr = &node["pullRequest"];
            if pr["state"].as_str() != Some("OPEN") {
                continue;
            }
            let field = |key: &str| {
                pr[key]
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("stack entry is missing {key}"))
            };
            let position = node["position"]
                .as_u64()
                .ok_or("stack entry has no position")?;
            let number = pr["number"]
                .as_u64()
                .ok_or("stack entry has no PR number")? as u32;
            entries.push((
                position,
                net::Pick {
                    number,
                    oid: field("headRefOid")?,
                    head: field("headRefName")?,
                    base: field("baseRefName")?,
                    local: false,
                },
            ));
        }
        if page["pageInfo"]["hasNextPage"].as_bool() != Some(true) {
            break;
        }
        let after = page["pageInfo"]["endCursor"]
            .as_str()
            .ok_or("GitHub stack page has no cursor")?;
        let query = format!(
            "query($id: ID!, $after: String!) {{
                node(id: $id) {{ ... on PullRequestStack {{ entries(first: 100, after: $after) {{ {ENTRIES} }} }} }}
            }}"
        );
        let mut data = graphql(&query, &[("id", id), ("after", after)])?;
        page = data["node"]["entries"].take();
    }
    entries.sort_by_key(|(position, _)| *position);
    Ok(entries.into_iter().map(|(_, pick)| pick).collect())
}

fn graphql(query: &str, fields: &[(&str, &str)]) -> Result<Value, String> {
    let mut cmd = Command::new("gh");
    cmd.args(["api", "graphql", "-f", &format!("query={query}")]);
    for (key, value) in fields {
        cmd.args(["-f", &format!("{key}={value}")]);
    }
    let out = cmd
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("gh: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(if err.trim().is_empty() {
            format!("gh api graphql exited with {}", out.status)
        } else {
            err.trim().to_string()
        });
    }
    let mut json: Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("gh api graphql: {e}"))?;
    if let Some(msg) = json["errors"][0]["message"].as_str() {
        return Err(msg.to_string());
    }
    Ok(json["data"].take())
}
