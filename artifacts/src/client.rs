//! The CLI side of `add`, `ls`, `get` and `rm`: gathers the context, inlines a spec's captures,
//! uploads the screenshots a page points at, and prints the page's URL.

use crate::context::gather;
use crate::db::now;
use crate::render::expand_home;
use crate::{content_type, server_url, Args};
use regex::Regex;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

fn not_running(error: reqwest::Error) -> String {
    if error.is_connect() {
        format!("no server at {}. Start it with `artifacts up`", server_url())
    } else {
        error.to_string()
    }
}

async fn ok(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    Err(format!("{status}: {body}"))
}

fn infer_kind(path: &str) -> Option<&'static str> {
    match path.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "json" => Some("code-path"),
        "md" | "markdown" => Some("md"),
        "html" | "htm" => Some("html"),
        _ => None,
    }
}

fn title_of(kind: &str, source: &str) -> Option<String> {
    match kind {
        "code-path" => serde_json::from_str::<Value>(source).ok()?.get("title")?.as_str().map(str::to_string),
        "md" => source.lines().find_map(|l| l.strip_prefix("# ")).map(|t| t.trim().to_string()),
        _ => {
            let re = Regex::new(r"(?is)<title[^>]*>(.*?)</title>|<h1[^>]*>(.*?)</h1>").ok()?;
            let caps = re.captures(source)?;
            let raw = caps.get(1).or_else(|| caps.get(2))?.as_str();
            let text = Regex::new(r"<[^>]+>").ok()?.replace_all(raw, "").trim().to_string();
            Some(text).filter(|t| !t.is_empty())
        }
    }
}

/// Relative files the page points at (`<img src="shots/a.png">`, `![](shots/a.png)`) that exist
/// next to it; uploaded under the same name so the links resolve as written.
fn referenced_files(source: &str, dir: &Path) -> Vec<String> {
    let patterns = [
        r#"(?i)\b(?:src|href|poster)\s*=\s*["']([^"'#?]+)["']"#,
        r"!\[[^\]]*\]\(\s*<?([^)\s>]+)",
    ];
    let mut found: Vec<String> = vec![];
    for pattern in patterns {
        let Ok(re) = Regex::new(pattern) else { continue };
        for caps in re.captures_iter(source) {
            let reference = caps[1].trim().trim_start_matches("./").to_string();
            let external = reference.contains("://")
                || reference.starts_with('/')
                || reference.starts_with('#')
                || reference.contains(':')
                || reference.split('/').any(|p| p == ".." || p.is_empty());
            if external || found.contains(&reference) || !dir.join(&reference).is_file() {
                continue;
            }
            found.push(reference);
        }
    }
    found
}

pub async fn add(raw: &[String]) -> Result<(), String> {
    let args = Args::parse(raw, &["check", "open", "new"])?;
    let input = args.positionals.first().ok_or("add needs a file, or - to read stdin")?;
    let cwd = match args.get("cwd") {
        Some(dir) => PathBuf::from(expand_home(&dir)),
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };

    let (mut source, file) = if input == "-" {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text).map_err(|e| e.to_string())?;
        (text, None)
    } else {
        let path = std::fs::canonicalize(expand_home(input)).map_err(|e| format!("{input}: {e}"))?;
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        (text, Some(path))
    };
    let kind = args
        .get("kind")
        .or_else(|| file.as_ref().and_then(|f| infer_kind(&f.to_string_lossy())).map(str::to_string))
        .unwrap_or_else(|| "md".into());
    let dir = file.as_ref().and_then(|f| f.parent().map(Path::to_path_buf)).unwrap_or_else(|| cwd.clone());

    let mut ctx = gather(&cwd);
    ctx.source_file = file.as_ref().map(|f| f.display().to_string());
    if let Some(ticket) = args.get("ticket") {
        ctx.ticket = Some(ticket.to_uppercase());
    }

    if kind == "code-path" {
        // Inline the capture files, so the page keeps its In/Out values after they're gone.
        let mut spec: Value = serde_json::from_str(&source).map_err(|e| format!("the spec is not JSON: {e}"))?;
        if let Some(captures) = spec.get("captures").and_then(Value::as_object).cloned() {
            let mut data = serde_json::Map::new();
            for (name, path) in captures {
                let rel = path.as_str().ok_or_else(|| format!("capture {name:?} is not a path"))?;
                let full = dir.join(expand_home(rel));
                let text = std::fs::read_to_string(&full).map_err(|e| format!("capture {}: {e}", full.display()))?;
                let value: Value = serde_json::from_str(&text).map_err(|e| format!("capture {}: {e}", full.display()))?;
                data.insert(name, value);
            }
            spec["captures_data"] = Value::Object(data);
            source = serde_json::to_string_pretty(&spec).map_err(|e| e.to_string())?;
        }
    }

    let title = args
        .get("title")
        .or_else(|| title_of(&kind, &source))
        .ok_or("no title: pass --title, or start the file with `# Title` / give the spec a \"title\"")?;

    let mut assets: Vec<(String, PathBuf)> = vec![];
    if kind != "code-path" {
        for name in referenced_files(&source, &dir) {
            let path = dir.join(&name);
            assets.push((name, path));
        }
    }
    for extra in args.all("asset") {
        let path = std::fs::canonicalize(expand_home(&extra)).map_err(|e| format!("{extra}: {e}"))?;
        let name = if !extra.starts_with('/') && !extra.starts_with('~') && !extra.contains("..") {
            extra.trim_start_matches("./").to_string()
        } else {
            path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(extra.clone())
        };
        if !assets.iter().any(|(n, _)| *n == name) {
            assets.push((name, path));
        }
    }

    let client = reqwest::Client::new();
    let body = json!({
        "kind": kind,
        "title": title,
        "summary": args.get("summary"),
        "question": args.get("question"),
        "source": source,
        "ctx": ctx,
        "slug": args.get("slug"),
        "new": args.has("new"),
        "check": args.has("check"),
    });
    let resp = client.post(format!("{}/api/artifacts", server_url())).json(&body).send().await.map_err(not_running)?;
    let saved: Value = ok(resp).await?.json().await.map_err(|e| e.to_string())?;

    if args.has("check") {
        print!("{}", saved["check"].as_str().unwrap_or(""));
        return Ok(());
    }
    let slug = saved["slug"].as_str().unwrap_or_default().to_string();
    for (name, path) in &assets {
        let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let resp = client
            .put(format!("{}/api/artifacts/{slug}/assets/{name}", server_url()))
            .header("content-type", content_type(name))
            .body(bytes)
            .send()
            .await
            .map_err(not_running)?;
        ok(resp).await?;
    }

    let url = saved["url"].as_str().unwrap_or_default();
    println!("{url}");
    let revision = saved["revision"].as_i64().unwrap_or(1);
    let place = match (ctx.slot, ctx.branch.as_deref()) {
        (Some(slot), Some(branch)) => format!(" · slot {slot} · {branch}"),
        (Some(slot), None) => format!(" · slot {slot}"),
        _ => String::new(),
    };
    eprintln!(
        "{} v{revision}{place}{}",
        if revision > 1 { "updated" } else { "created" },
        if assets.is_empty() { String::new() } else { format!(" · {} assets", assets.len()) }
    );
    if args.has("open") {
        let _ = std::process::Command::new("open").arg(url).status();
    }
    Ok(())
}

async fn is_up() -> bool {
    reqwest::Client::new()
        .get(format!("{}/api/artifacts?limit=1", server_url()))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

fn herdr_json(args: &[&str]) -> Result<Value, String> {
    let out = std::process::Command::new("herdr").args(args).output().map_err(|e| format!("herdr: {e}"))?;
    if !out.status.success() {
        return Err(format!("herdr {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("herdr {}: {e}", args.join(" ")))
}

/// Make sure the server is running: if not, start it in its own tab of the herdr `servers`
/// workspace, where every long-running server lives.
pub async fn up(_raw: &[String]) -> Result<(), String> {
    if is_up().await {
        println!("running at {}", server_url().replace("127.0.0.1", "localhost"));
        return Ok(());
    }
    if std::env::var("HERDR_ENV").as_deref() != Ok("1") {
        return Err(format!(
            "not running, and this shell is not in herdr. Start it by hand: cd {} && ./target/release/artifacts serve",
            env!("CARGO_MANIFEST_DIR")
        ));
    }
    let workspaces = herdr_json(&["workspace", "list"])?;
    let servers = workspaces["result"]["workspaces"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|w| matches!(w["label"].as_str(), Some("servers" | "server")))
        .and_then(|w| w["workspace_id"].as_str())
        .ok_or("no herdr workspace labeled `servers`")?
        .to_string();
    let tab = herdr_json(&[
        "tab", "create", "--workspace", &servers, "--cwd", env!("CARGO_MANIFEST_DIR"), "--label", "artifacts :4620", "--no-focus",
    ])?;
    let pane = tab["result"]["root_pane"]["pane_id"].as_str().ok_or("herdr tab create returned no pane")?.to_string();
    let exe = std::env::current_exe().and_then(|p| p.canonicalize()).map_err(|e| e.to_string())?;
    let status = std::process::Command::new("herdr")
        .args(["pane", "run", &pane, &format!("{} serve", exe.display())])
        .status()
        .map_err(|e| format!("herdr pane run: {e}"))?;
    if !status.success() {
        return Err(format!("herdr pane run {pane} failed"));
    }
    for _ in 0..40 {
        if is_up().await {
            println!("started at {} (herdr {servers}, pane {pane})", server_url().replace("127.0.0.1", "localhost"));
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    Err(format!("started in herdr pane {pane} but it is not answering; read it with `herdr pane read {pane}`"))
}

fn age(ts: i64) -> String {
    let s = now() - ts;
    match s {
        s if s < 60 => "now".into(),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86400 => format!("{}h", s / 3600),
        s => format!("{}d", s / 86400),
    }
}

pub async fn ls(raw: &[String]) -> Result<(), String> {
    let args = Args::parse(raw, &[])?;
    let mut query: Vec<(String, String)> = vec![("limit".into(), args.get("limit").unwrap_or_else(|| "30".into()))];
    for key in ["slot", "q", "kind"] {
        if let Some(v) = args.get(key) {
            query.push((key.into(), v));
        }
    }
    let resp = reqwest::Client::new()
        .get(format!("{}/api/artifacts", server_url()))
        .query(&query)
        .send()
        .await
        .map_err(not_running)?;
    let items: Vec<Value> = ok(resp).await?.json().await.map_err(|e| e.to_string())?;
    for item in items {
        let slot = item["slot"].as_i64().map(|s| format!("s{s}")).unwrap_or_else(|| "-".into());
        println!(
            "{:<5} {:<4} {:<9} {:<42} {}",
            age(item["updated_at"].as_i64().unwrap_or(0)),
            slot,
            item["kind"].as_str().unwrap_or(""),
            item["slug"].as_str().unwrap_or(""),
            item["title"].as_str().unwrap_or("")
        );
    }
    Ok(())
}

pub async fn get(raw: &[String]) -> Result<(), String> {
    let slug = raw.first().ok_or("get needs a slug")?;
    let resp = reqwest::Client::new()
        .get(format!("{}/api/artifacts/{slug}", server_url()))
        .send()
        .await
        .map_err(not_running)?;
    let item: Value = ok(resp).await?.json().await.map_err(|e| e.to_string())?;
    print!("{}", item["source"].as_str().unwrap_or(""));
    Ok(())
}

pub async fn rm(raw: &[String]) -> Result<(), String> {
    let slug = raw.first().ok_or("rm needs a slug")?;
    let resp = reqwest::Client::new()
        .delete(format!("{}/api/artifacts/{slug}", server_url()))
        .send()
        .await
        .map_err(not_running)?;
    ok(resp).await?;
    eprintln!("deleted {slug}");
    Ok(())
}
