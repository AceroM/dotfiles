//! Runs a page's shell blocks on this machine. `POST /api/run` takes the code, starts it in its
//! own process group in the page's checkout (or the block's `cwd`), and streams its output back as
//! JSON lines while it runs:
//!
//! ```text
//! {"cwd":"/Users/me/src/repo.3","pid":4242}
//! {"o":"stdout text"}   {"e":"stderr text"}
//! {"exit":0,"signal":null,"ms":812}
//! ```
//!
//! Closing the request (the page's stop button, or leaving the page) stops the whole group.
//! Only this server's own pages can ask: the Host and Origin must both be this server, which
//! keeps other sites, and DNS rebinding, from running anything.

use crate::render::expand_home;
use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap},
};
use serde_json::{json, Map, Value};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::mpsc;
use tokio_stream::{wrappers::ReceiverStream, StreamExt};

/// Whether the request came from a page this server served, on either name it answers to.
pub fn same_origin(headers: &HeaderMap, port: u16) -> bool {
    let hosts = [format!("localhost:{port}"), format!("127.0.0.1:{port}")];
    let get = |name| headers.get(name).and_then(|v| v.to_str().ok());
    let host_ok = get(header::HOST).is_some_and(|h| hosts.iter().any(|x| x == h));
    let origin_ok = get(header::ORIGIN).is_some_and(|o| hosts.iter().any(|x| o == format!("http://{x}")));
    host_ok && origin_ok
}

/// `bash` for bash, sh and shell blocks, `zsh` for zsh. Neither loads rc files, so aliases and
/// shell functions are out; everything on the server's PATH is in.
pub fn shell_for(name: Option<&str>) -> &'static str {
    match name {
        Some("zsh") => "zsh",
        _ => "bash",
    }
}

/// The block's `cwd` if it has one (relative to the page's directory), else the page's directory.
pub fn resolve_dir(block_cwd: Option<&str>, page_dir: Option<&str>) -> Result<PathBuf, String> {
    let home = expand_home("~");
    let base = PathBuf::from(page_dir.map(expand_home).unwrap_or(home));
    let dir = match block_cwd.map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) => {
            let c = PathBuf::from(expand_home(c));
            if c.is_absolute() { c } else { base.join(c) }
        }
        None => base,
    };
    if dir.is_dir() {
        Ok(dir)
    } else {
        Err(format!("{} is not a directory on this machine", dir.display()))
    }
}

fn line(value: Value) -> Bytes {
    let mut text = value.to_string();
    text.push('\n');
    Bytes::from(text)
}

/// Forwards a pipe as `{"o": …}` or `{"e": …}` lines, never splitting a UTF-8 character.
async fn pump(mut pipe: impl AsyncRead + Unpin, key: &'static str, tx: mpsc::Sender<Bytes>) {
    let mut buf = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let n = match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.extend_from_slice(&buf[..n]);
        let whole = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => pending.len(),
        };
        let text = String::from_utf8_lossy(&pending[..whole]).into_owned();
        pending.drain(..whole);
        if text.is_empty() {
            continue;
        }
        let mut chunk = Map::new();
        chunk.insert(key.into(), text.into());
        if tx.send(line(Value::Object(chunk))).await.is_err() {
            return;
        }
    }
    if !pending.is_empty() {
        let mut chunk = Map::new();
        chunk.insert(key.into(), String::from_utf8_lossy(&pending).into_owned().into());
        let _ = tx.send(line(Value::Object(chunk))).await;
    }
}

fn signal_group(pgid: u32, signal: i32) {
    // SAFETY: killpg only sends a signal; a group that has already exited returns ESRCH.
    unsafe {
        libc::killpg(pgid as libc::pid_t, signal);
    }
}

pub struct Run<'a> {
    pub code: &'a str,
    pub shell: &'static str,
    pub dir: &'a Path,
    pub slug: Option<&'a str>,
}

/// Starts the block and returns the body that streams it. The process lives as long as the body
/// is being read.
pub fn start(run: Run) -> Result<Body, String> {
    let mut command = tokio::process::Command::new(run.shell);
    command
        .arg("-c")
        .arg(run.code)
        .current_dir(run.dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PAGER", "cat")
        .env("GIT_PAGER", "cat")
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .process_group(0)
        .kill_on_drop(true);
    if let Some(slug) = run.slug {
        command.env("ARTIFACTS_SLUG", slug);
    }
    let mut child = command.spawn().map_err(|e| format!("starting {}: {e}", run.shell))?;
    let pid = child.id().ok_or("the block exited before it started")?;
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let (tx, rx) = mpsc::channel::<Bytes>(256);
    let dir = run.dir.display().to_string();
    let home = expand_home("~");
    let dir = match dir.strip_prefix(&home) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("~{rest}"),
        _ => dir,
    };

    tokio::spawn(async move {
        let started = Instant::now();
        let _ = tx.send(line(json!({ "cwd": dir, "pid": pid }))).await;
        let status = {
            let finished = async {
                if let (Some(out), Some(err)) = (stdout, stderr) {
                    tokio::join!(pump(out, "o", tx.clone()), pump(err, "e", tx.clone()));
                }
                child.wait().await
            };
            tokio::select! {
                status = finished => Some(status),
                _ = tx.closed() => None,
            }
        };
        match status {
            Some(status) => {
                let status = status.ok();
                let _ = tx
                    .send(line(json!({
                        "exit": status.and_then(|s| s.code()),
                        "signal": status.and_then(|s| s.signal()),
                        "ms": started.elapsed().as_millis() as u64,
                    })))
                    .await;
            }
            // The page stopped it or went away: TERM the group, then KILL whatever is left.
            None => {
                signal_group(pid, libc::SIGTERM);
                if tokio::time::timeout(Duration::from_secs(2), child.wait()).await.is_err() {
                    signal_group(pid, libc::SIGKILL);
                }
                println!("run  stopped pid {pid} after {:.1}s", started.elapsed().as_secs_f32());
            }
        }
    });

    Ok(Body::from_stream(ReceiverStream::new(rx).map(Ok::<_, std::convert::Infallible>)))
}
