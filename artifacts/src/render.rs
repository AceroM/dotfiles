//! Turns what an agent sends into the HTML a page shows.
//!
//! - `code-path`: the same JSON spec `~/.claude/skills/code-path/scripts/detailed_code_path.py`
//!   takes, rendered here from `git show <sha>:<path>`: one accordion per hop, the block around
//!   the line with the focus lines highlighted, a pinned GitHub permalink and a `path:line` that
//!   copies on click.
//! - `md`: markdown, with mermaid blocks, and every repo-relative `path:line` copyable on click.
//! - `html`: stored as sent. A full document is shown in a frame, a fragment inline.

use crate::context::Context;
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::process::Command;
use std::sync::OnceLock;

pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/Users/miguelacero".into())
}

pub fn expand_home(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => format!("{}/{rest}", home()),
        None if path == "~" => home(),
        None => path.to_string(),
    }
}

// ---------------------------------------------------------------------------------------------
// code-path

pub struct CodePath {
    pub html: String,
    /// The `--check` report: every highlighted line and every resolved In/Out value.
    pub check: String,
}

#[derive(Default)]
struct Git {
    shas: HashMap<(String, String), String>,
    files: HashMap<(String, String, String), Vec<String>>,
    pushed: HashMap<(String, String), bool>,
}

fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {} (in {dir}): {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn git_ok(dir: &str, args: &[&str]) -> bool {
    Command::new("git").arg("-C").arg(dir).args(args).output().map(|o| o.status.success()).unwrap_or(false)
}

impl Git {
    fn resolve(&mut self, checkout: &str, reference: &str) -> Result<String, String> {
        let key = (checkout.to_string(), reference.to_string());
        if let Some(sha) = self.shas.get(&key) {
            return Ok(sha.clone());
        }
        let sha = git(checkout, &["rev-parse", &format!("{reference}^{{commit}}")])?.trim().to_string();
        self.shas.insert(key, sha.clone());
        Ok(sha)
    }

    fn lines(&mut self, checkout: &str, sha: &str, path: &str) -> Result<&Vec<String>, String> {
        let key = (checkout.to_string(), sha.to_string(), path.to_string());
        if !self.files.contains_key(&key) {
            let text = git(checkout, &["show", &format!("{sha}:{path}")])?;
            self.files.insert(key.clone(), text.lines().map(str::to_string).collect());
        }
        Ok(&self.files[&key])
    }

    /// Whether the commit is on GitHub, so its permalinks resolve. Checks `origin/main` and the
    /// remote copy of the branch in play, which is fast; a full `branch -r --contains` scan takes
    /// seconds on a large repo, so a commit on some other remote branch reads as unpushed.
    fn on_remote(&mut self, checkout: &str, sha: &str, refs: &[String]) -> bool {
        let key = (checkout.to_string(), sha.to_string());
        if let Some(pushed) = self.pushed.get(&key) {
            return *pushed;
        }
        let mut candidates = vec!["origin/main".to_string()];
        for r in refs {
            let looks_like_sha = r.len() >= 7 && r.chars().all(|c| c.is_ascii_hexdigit());
            if r.is_empty() || looks_like_sha || r == "HEAD" {
                continue;
            }
            let remote = if r.starts_with("origin/") { r.clone() } else { format!("origin/{r}") };
            if !candidates.contains(&remote) {
                candidates.push(remote);
            }
        }
        let pushed = candidates.iter().any(|c| {
            git_ok(checkout, &["rev-parse", "--verify", "-q", c])
                && git_ok(checkout, &["merge-base", "--is-ancestor", sha, c])
        });
        self.pushed.insert(key, pushed);
        pushed
    }
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// `{"$": "name:dotted.path"}` reads a value out of a capture; anything else is shown as written.
fn resolve_value(value: &Value, captures: &Map<String, Value>) -> Result<Value, String> {
    let Some(reference) = value.as_object().filter(|o| o.len() == 1).and_then(|o| o.get("$")).and_then(Value::as_str) else {
        return Ok(value.clone());
    };
    let (name, dotted) = reference.split_once(':').unwrap_or((reference, ""));
    let mut node = captures
        .get(name)
        .ok_or_else(|| format!("io value {reference:?}: no capture named {name:?}"))?;
    for part in dotted.split('.').filter(|p| !p.is_empty()) {
        node = match node {
            Value::Array(items) if part.parse::<usize>().is_ok() => items.get(part.parse::<usize>().unwrap_or(0)),
            Value::Object(map) => map.get(part),
            _ => None,
        }
        .ok_or_else(|| format!("io value {reference:?}: {part:?} not found in capture {name:?}"))?;
    }
    Ok(node.clone())
}

fn show(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

fn render_io(io: &Value, captures: &Map<String, Value>, check: &mut String) -> Result<String, String> {
    let mut cols = String::new();
    for (key, title) in [("in", "In"), ("out", "Out")] {
        let mut rows = String::new();
        for pair in io.get(key).and_then(Value::as_array).into_iter().flatten() {
            let name = pair.get(0).and_then(Value::as_str).unwrap_or("");
            let value = show(&resolve_value(pair.get(1).unwrap_or(&Value::Null), captures)?);
            let one_line: String = value.replace('\n', " ").chars().take(110).collect();
            check.push_str(&format!("    {title:<4}{name} = {one_line}\n"));
            rows.push_str(&format!("<dt>{}</dt><dd>{}</dd>", escape(name), escape(&value)));
        }
        cols.push_str(&format!(
            r#"<div class="dcp-io-{key}"><span class="dcp-io-h">{title}</span><dl>{rows}</dl></div>"#
        ));
    }
    let note = str_field(io, "note")
        .map(|n| format!(r#"<div class="dcp-io-note">{}</div>"#, escape(n)))
        .unwrap_or_default();
    Ok(format!(r#"<div class="dcp-io">{cols}{note}</div>"#))
}

/// `"run"` on the spec or on a hop: shell blocks with a ▶ that runs them on this machine. Each is
/// the code as a string, or `{"code", "title", "cwd", "shell"}`; one block or a list. A hop's
/// blocks run in its side's checkout unless they name a `cwd` (relative paths are taken from there).
fn render_runs(value: Option<&Value>, base: Option<&str>, check: &mut String) -> Result<String, String> {
    let items: Vec<&Value> = match value {
        None => return Ok(String::new()),
        Some(Value::Array(items)) => items.iter().collect(),
        Some(one) => vec![one],
    };
    let mut out = String::new();
    for item in items {
        let (code, title, own_cwd, shell) = match item {
            Value::String(code) => (code.as_str(), None, None, None),
            Value::Object(_) => (
                str_field(item, "code").ok_or("a run block has no \"code\"")?,
                str_field(item, "title"),
                str_field(item, "cwd"),
                str_field(item, "shell"),
            ),
            _ => return Err("a run block is a string or {\"code\": …}".into()),
        };
        let cwd = match (own_cwd, base) {
            (Some(own), Some(base)) if !own.starts_with('/') && !own.starts_with('~') => Some(format!("{base}/{own}")),
            (Some(own), _) => Some(own.to_string()),
            (None, base) => base.map(str::to_string),
        };
        let first: String = code.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().chars().take(90).collect();
        check.push_str(&format!("{:<9} {} $ {first}\n", "run", cwd.as_deref().unwrap_or("(page)")));
        let title = title.map(|t| format!(r#"<span class="dcp-run-h">{}</span>"#, escape(t))).unwrap_or_default();
        let cwd = cwd.map(|c| format!(r#" data-cwd="{}""#, escape(&c))).unwrap_or_default();
        let shell = shell.map(|s| format!(r#" data-shell="{}""#, escape(s))).unwrap_or_default();
        out.push_str(&format!(
            r#"<div class="dcp-run">{title}<pre data-run{cwd}{shell}><code class="language-bash">{}</code></pre></div>"#,
            escape(code.trim_end())
        ));
    }
    Ok(out)
}

pub fn code_path(spec: &Value, ctx: &Context) -> Result<CodePath, String> {
    let github = str_field(spec, "github").map(str::to_string).or_else(|| ctx.github.clone());
    let captures = spec.get("captures_data").and_then(Value::as_object).cloned().unwrap_or_default();
    let open = if spec.get("collapsed").and_then(Value::as_bool).unwrap_or(false) { "" } else { " open" };
    let groups = spec.get("groups").and_then(Value::as_array).ok_or("the spec has no \"groups\" array")?;

    let mut repo = Git::default();
    let mut out = String::from(r#"<section class="dcp">"#);
    let mut check = String::new();
    if let Some(intro) = str_field(spec, "intro") {
        out.push_str(&format!("<p>{}</p>", escape(intro)));
    }
    if let Some(note) = str_field(spec, "capture_note") {
        out.push_str(&format!(r#"<p class="dcp-capture">{}</p>"#, escape(note)));
    }
    out.push_str(&render_runs(spec.get("run"), None, &mut check)?);
    out.push_str(r#"<div class="dcp-controls"><button type="button" class="dcp-expand">Expand all</button><button type="button" class="dcp-collapse">Collapse all</button></div>"#);

    for group in groups {
        if let Some(title) = str_field(group, "title") {
            out.push_str(&format!("<h3>{}</h3>", escape(title)));
        }
        out.push_str(r#"<div class="dcp-paths">"#);
        for side in group.get("sides").and_then(Value::as_array).ok_or("a group has no \"sides\" array")? {
            let checkout = str_field(side, "checkout")
                .map(expand_home)
                .or_else(|| ctx.repo_root.clone())
                .ok_or("a side has no \"checkout\" and the page was not added from a git checkout")?;
            let reference = str_field(side, "ref").map(str::to_string).or_else(|| ctx.sha.clone()).unwrap_or_else(|| "HEAD".into());
            let sha = repo.resolve(&checkout, &reference)?;
            let checkout_branch = git(&checkout, &["branch", "--show-current"]).map(|b| b.trim().to_string()).unwrap_or_default();
            let pushed = repo.on_remote(&checkout, &sha, &[reference.clone(), checkout_branch]);
            let tag = str_field(side, "tag").unwrap_or("");
            let class = match tag.to_ascii_lowercase().as_str() {
                "before" => "before",
                "after" => "after",
                _ => "",
            };
            let sha_link = match (&github, pushed) {
                (Some(github), true) => format!(r#"<a class="dcp-sha" href="https://github.com/{github}/commit/{sha}" target="_blank" rel="noopener">{}</a>"#, &sha[..10]),
                (None, true) => format!(r#"<span class="dcp-sha">{}</span>"#, &sha[..10]),
                (_, false) => format!(r#"<span class="dcp-sha off" title="This commit is not on origin/main or its branch's remote, so GitHub links would 404">{} · not pushed</span>"#, &sha[..10]),
            };
            out.push_str(&format!(
                r#"<div class="dcp-path {class}"><div class="dcp-head"><span class="dcp-tag">{}</span> <span>{}</span>{sha_link}</div>"#,
                escape(tag),
                escape(str_field(side, "caption").unwrap_or(""))
            ));
            if let Some(note) = str_field(side, "capture_note") {
                out.push_str(&format!(r#"<p class="dcp-capture">{}</p>"#, escape(note)));
            }
            out.push_str(r#"<ol class="dcp-hops">"#);
            for hop in side.get("hops").and_then(Value::as_array).ok_or("a side has no \"hops\" array")? {
                let path = str_field(hop, "path").ok_or("a hop has no \"path\"")?;
                let label = str_field(hop, "label").unwrap_or(path);
                let focus: Vec<usize> = hop
                    .get("focus")
                    .and_then(Value::as_array)
                    .map(|f| f.iter().filter_map(Value::as_u64).map(|n| n as usize).collect())
                    .unwrap_or_default();
                if focus.is_empty() {
                    return Err(format!("hop {path:?} has no \"focus\" lines"));
                }
                let src = repo.lines(&checkout, &sha, path)?;
                if let Some(bad) = focus.iter().find(|n| **n == 0 || **n > src.len()) {
                    return Err(format!("{path}:{bad} is past the end of the file at {} ({} lines)", &sha[..10], src.len()));
                }
                let first = focus[0];
                let last = *focus.iter().max().unwrap_or(&first);
                let from = hop.get("from").and_then(Value::as_u64).map(|n| n as usize).unwrap_or(first.saturating_sub(4)).max(1);
                let to = hop.get("to").and_then(Value::as_u64).map(|n| n as usize).unwrap_or(last + 6).min(src.len());
                for n in &focus {
                    let code: String = src[n - 1].trim().chars().take(90).collect();
                    check.push_str(&format!("{tag:<9} {path}:{n:<6} {code}\n"));
                }
                let mut rows = String::new();
                for n in from..=to {
                    let hit = if focus.contains(&n) { r#" class="hit""# } else { "" };
                    let code = escape(&src[n - 1]);
                    rows.push_str(&format!(
                        r#"<span{hit}><span class="ln">{n}</span>{}</span>"#,
                        if code.is_empty() { " ".to_string() } else { code }
                    ));
                }
                let io = match hop.get("io") {
                    Some(io) => render_io(io, &captures, &mut check)?,
                    None => String::new(),
                };
                let runs = render_runs(hop.get("run"), Some(&checkout), &mut check)?;
                let gh = if let (true, Some(github)) = (pushed, &github) {
                    format!(
                        r#"<a class="dcp-gh" href="https://github.com/{github}/blob/{sha}/{path}#L{from}-L{to}" target="_blank" rel="noopener">GitHub ↗</a>"#
                    )
                } else {
                    String::new()
                };
                out.push_str(&format!(
                    r#"<li><details{open}><summary><span class="dcp-label">{}</span><span class="dcp-loc" data-copy="{loc}" title="Copy {loc}">{loc}</span>{gh}</summary><pre class="dcp-src"><code>{rows}</code></pre>{io}{runs}</details></li>"#,
                    escape(label),
                    loc = escape(&format!("{path}:{first}"))
                ));
            }
            out.push_str("</ol></div>");
        }
        out.push_str("</div>");
    }
    out.push_str("</section>");
    Ok(CodePath { html: out, check })
}

// ---------------------------------------------------------------------------------------------
// markdown

fn location_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?:~/|/)?(?:[A-Za-z0-9_@.\[\]-]+/)+[A-Za-z0-9_@.\[\]-]+\.[A-Za-z0-9]{1,8}:\d+").expect("location regex")
    })
}

/// Make every `path/to/file.ts:123` in already-escaped text copy itself on click, for pasting
/// into Zed. Only on pages written from a checkout, where repo-relative paths mean something.
fn linkify(escaped: &str, base: Option<&str>) -> String {
    if base.is_none() {
        return escaped.to_string();
    }
    let mut out = String::with_capacity(escaped.len());
    let mut last = 0;
    for m in location_re().find_iter(escaped) {
        let before = escaped[..m.start()].chars().next_back();
        if before.is_some_and(|c| c.is_alphanumeric() || matches!(c, '/' | ':' | '.' | '-' | '_')) {
            continue;
        }
        let text = m.as_str();
        out.push_str(&escaped[last..m.start()]);
        out.push_str(&format!(r#"<span class="loc" data-copy="{text}" title="Copy {text}">{text}</span>"#));
        last = m.end();
    }
    out.push_str(&escaped[last..]);
    out
}

/// Drop a leading `# Title` line when it repeats the page title, since the page shows it already.
fn strip_title<'a>(src: &'a str, title: &str) -> &'a str {
    let trimmed = src.trim_start();
    if let Some(rest) = trimmed.strip_prefix("# ") {
        let (line, after) = rest.split_once('\n').unwrap_or((rest, ""));
        if line.trim() == title.trim() {
            return after;
        }
    }
    src
}

pub fn markdown(src: &str, title: &str, base: Option<&str>) -> String {
    let src = strip_title(src, title);
    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_FOOTNOTES;
    let mut in_link = 0usize;
    let mut in_mermaid = false;
    let events = Parser::new_ext(src, options).map(|event| match event {
        Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(lang))) if lang.as_ref() == "mermaid" => {
            in_mermaid = true;
            Event::Html(r#"<pre class="mermaid">"#.into())
        }
        Event::End(TagEnd::CodeBlock) if in_mermaid => {
            in_mermaid = false;
            Event::Html("</pre>".into())
        }
        Event::Start(Tag::Link { .. }) => {
            in_link += 1;
            event
        }
        Event::End(TagEnd::Link) => {
            in_link = in_link.saturating_sub(1);
            event
        }
        Event::Text(text) if in_link == 0 && !in_mermaid => Event::Html(linkify(&escape(&text), base).into()),
        Event::Code(code) if in_link == 0 => Event::Html(format!("<code>{}</code>", linkify(&escape(&code), base)).into()),
        other => other,
    });
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, events);
    html
}

// ---------------------------------------------------------------------------------------------
// html

pub fn is_full_document(src: &str) -> bool {
    let head: String = src.chars().take(2000).collect::<String>().to_ascii_lowercase();
    head.contains("<!doctype") || head.contains("<html")
}
