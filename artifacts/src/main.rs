//! One local server for every code path and artifact an agent writes.
//!
//! `artifacts serve` keeps them in one SQLite file and serves them at http://localhost:4620: the
//! home page lists the recent ones, and each lives at /a/<slug>/. `artifacts add <file>` sends a
//! page along with the context it was written in (checkout, branch, SHA, ticket, herdr tab, agent
//! session), so every page says where it came from. Open pages reload themselves when they change.

mod client;
mod context;
mod db;
mod pages;
mod render;
mod run;
mod server;

use std::process::ExitCode;

pub const DEFAULT_PORT: u16 = 4620;

const USAGE: &str = "\
usage:
  artifacts up                start the server in the herdr `servers` workspace if it is not running
  artifacts serve [--port 4620] [--db <path>]
  artifacts add <file|-> [--kind code-path|md|html] [--title T] [--summary S] [--question Q]
                         [--slug S] [--new] [--cwd DIR] [--asset FILE]... [--check] [--open]
  artifacts ls [--limit N] [--tag T] [--q TEXT]
  artifacts get <slug>        print the source, to edit and re-add with --slug
  artifacts rm <slug>
  artifacts tag [ls]          this machine's tags: tag add <tag> <glob>, tag rm <tag> [<glob>]

kinds: code-path (.json spec, rendered from git), md (.md), html (.html). Inferred from the extension.
Re-adding the same file updates its page (for a temp file, only from the same agent session); --new forces a new one.
Server: $ARTIFACTS_URL (default http://localhost:4620).";

pub fn server_url() -> String {
    std::env::var("ARTIFACTS_URL").unwrap_or_else(|_| format!("http://127.0.0.1:{DEFAULT_PORT}"))
}

pub fn content_type(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "md" | "txt" | "log" | "csv" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rest = args.get(1..).unwrap_or(&[]);
    let result = match args.first().map(String::as_str) {
        Some("serve") => server::serve(rest).await,
        Some("up") => client::up(rest).await,
        Some("add") => client::add(rest).await,
        Some("ls") => client::ls(rest).await,
        Some("get") => client::get(rest).await,
        Some("rm") => client::rm(rest).await,
        Some("tag") => client::tag(rest).await,
        Some("-h" | "--help" | "help") => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("artifacts: {error}");
            ExitCode::FAILURE
        }
    }
}

/// Minimal flag parser: `--name value`, repeatable flags, bare `--switch`, and positionals.
pub struct Args {
    pub positionals: Vec<String>,
    pairs: Vec<(String, String)>,
    switches: Vec<String>,
}

impl Args {
    pub fn parse(raw: &[String], switches: &[&str]) -> Result<Args, String> {
        let mut parsed = Args { positionals: vec![], pairs: vec![], switches: vec![] };
        let mut iter = raw.iter();
        while let Some(arg) = iter.next() {
            if let Some(name) = arg.strip_prefix("--") {
                if switches.contains(&name) {
                    parsed.switches.push(name.to_string());
                } else {
                    let value = iter.next().ok_or_else(|| format!("--{name} needs a value"))?;
                    parsed.pairs.push((name.to_string(), value.clone()));
                }
            } else {
                parsed.positionals.push(arg.clone());
            }
        }
        Ok(parsed)
    }

    pub fn get(&self, name: &str) -> Option<String> {
        self.pairs.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v.clone())
    }

    pub fn all(&self, name: &str) -> Vec<String> {
        self.pairs.iter().filter(|(n, _)| n == name).map(|(_, v)| v.clone()).collect()
    }

    pub fn has(&self, name: &str) -> bool {
        self.switches.iter().any(|s| s == name)
    }
}
