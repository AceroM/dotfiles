//! The browser-use native host, straight over its unix socket: one JSON request
//! per connection, about a millisecond. The host relays to the browser-use
//! extension, whose `switcher.*` commands (extension/switcher.js) are ctab's:
//! any tab in the browser, and none of them attach the debugger.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;

use serde_json::{json, Value};

#[derive(Clone)]
pub struct Host {
    socket: PathBuf,
    /// "Google Chrome", "Helium", … as the extension reports it.
    pub browser: String,
}

fn hosts_dir() -> PathBuf {
    let state = match std::env::var_os("XDG_STATE_HOME") {
        Some(s) if !s.is_empty() => PathBuf::from(s),
        _ => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/state"),
    };
    state.join("browser-use/hosts")
}

/// The browser to talk to: the newest host that answers, or the newest whose
/// browser name contains `want` (--browser, $BROWSER_USE_BROWSER).
pub fn pick(want: Option<&str>) -> Result<Host, String> {
    let mut found: Vec<(f64, Host)> = std::fs::read_dir(hosts_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| {
            let v: Value = serde_json::from_slice(&std::fs::read(e.path()).ok()?).ok()?;
            let host = Host { socket: v["socket"].as_str()?.into(), browser: v["browser"].as_str().unwrap_or("browser").to_string() };
            Some((v["started"].as_f64().unwrap_or(0.0), host))
        })
        .collect();
    found.sort_by(|a, b| b.0.total_cmp(&a.0));
    let names: Vec<String> = found.iter().map(|(_, h)| h.browser.clone()).collect();
    let matches = |h: &Host| want.is_none_or(|w| h.browser.to_lowercase().contains(&w.to_lowercase()));
    // A browser that quit without cleaning up leaves its files: skip what doesn't answer.
    if let Some((_, h)) = found.into_iter().find(|(_, h)| matches(h) && UnixStream::connect(&h.socket).is_ok()) {
        return Ok(h);
    }
    match want {
        Some(w) if !names.is_empty() => Err(format!("no connected browser matches \"{w}\" (connected: {})", names.join(", "))),
        _ => Err("no browser connected: is the browser-use extension loaded? (`browser-use status`)".to_string()),
    }
}

impl Host {
    /// One request; the `result` on success, the error's message otherwise.
    pub fn call(&self, cmd: &str, args: Value, timeout: Duration) -> Result<Value, String> {
        let mut s = UnixStream::connect(&self.socket).map_err(|e| format!("browser-use host: {e}"))?;
        let _ = s.set_read_timeout(Some(timeout));
        writeln!(s, "{}", json!({ "cmd": cmd, "args": args, "owner": "ctab" })).map_err(|e| format!("browser-use host: {e}"))?;
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).map_err(|e| format!("{cmd}: {e}"))?;
        let mut v: Value = serde_json::from_str(&line).map_err(|e| format!("{cmd}: {e}"))?;
        match v.get("error").and_then(Value::as_str) {
            Some(e) if e.starts_with("unknown command: switcher.") => {
                Err("the browser-use extension predates ctab: run `browser-use reload`".to_string())
            }
            Some(e) => Err(e.to_string()),
            None => Ok(v["result"].take()),
        }
    }

    /// Bring the browser app forward (switcher.focus raises the window inside it).
    pub fn activate(&self) {
        let _ = Command::new("open")
            .args(["-a", &self.browser])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

// ---- tabs ------------------------------------------------------------------

pub struct Tab {
    pub id: i64,
    pub window: i64,
    pub index: i64,
    pub title: String,
    pub url: String,
    /// The tab its window is showing.
    pub active: bool,
    pub audible: bool,
    pub muted: bool,
    /// Unloaded by Chrome to save memory: no page to read until it's woken.
    pub discarded: bool,
    pub loading: bool,
    /// -1 when ungrouped.
    pub group: i64,
    /// When it was last the active tab (ms since the epoch).
    pub last: f64,
    /// The agent driving it (`claude@w1R:pA`), for Agents-group tabs.
    pub owner: Option<String>,
}

impl Tab {
    pub fn display_title(&self) -> &str {
        if self.title.trim().is_empty() {
            &self.url
        } else {
            &self.title
        }
    }

    /// `github.com`, `localhost:3038`, `file`, `chrome://settings`.
    pub fn host(&self) -> String {
        let u = self.url.as_str();
        if let Some(rest) = u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")) {
            let h = rest.split(['/', '?', '#']).next().unwrap_or("");
            return h.strip_prefix("www.").unwrap_or(h).to_string();
        }
        if u.starts_with("file://") {
            return "file".to_string();
        }
        u.split(['/', '?', '#']).take(3).collect::<Vec<_>>().join("/")
    }

    /// The URL without its scheme or `www.`, for matching.
    pub fn short_url(&self) -> &str {
        let u = self.url.as_str();
        let u = u.split_once("://").map_or(u, |(_, r)| r);
        u.strip_prefix("www.").unwrap_or(u)
    }

    /// `claude` from `claude@w1R:pA`.
    pub fn owner_kind(&self) -> Option<&str> {
        self.owner.as_deref().map(|o| o.split('@').next().unwrap_or(o))
    }
}

pub struct Group {
    pub title: String,
    pub color: String,
}

pub struct Window {
    pub id: i64,
    pub focused: bool,
    pub incognito: bool,
}

/// Every tab, in tab-strip order: windows oldest first, then left to right.
pub struct Snap {
    pub tabs: Vec<Tab>,
    pub groups: HashMap<i64, Group>,
    pub windows: Vec<Window>,
}

pub fn list(host: &Host) -> Result<Snap, String> {
    let v = host.call("switcher.tabs", json!({}), Duration::from_secs(2))?;
    let arr = |k: &str| v[k].as_array().cloned().unwrap_or_default();
    let s = |o: &Value, k: &str| o[k].as_str().unwrap_or("").to_string();
    let i = |o: &Value, k: &str| o[k].as_i64().unwrap_or(-1);
    let b = |o: &Value, k: &str| o[k].as_bool().unwrap_or(false);
    let mut windows: Vec<Window> =
        arr("windows").iter().map(|w| Window { id: i(w, "id"), focused: b(w, "focused"), incognito: b(w, "incognito") }).collect();
    windows.sort_by_key(|w| w.id);
    let groups = arr("groups").iter().map(|g| (i(g, "id"), Group { title: s(g, "title"), color: s(g, "color") })).collect();
    let mut tabs: Vec<Tab> = arr("tabs")
        .iter()
        .map(|t| Tab {
            id: i(t, "id"),
            window: i(t, "windowId"),
            index: i(t, "index"),
            title: s(t, "title"),
            url: s(t, "url"),
            active: b(t, "active"),
            audible: b(t, "audible"),
            muted: b(t, "muted"),
            discarded: b(t, "discarded"),
            loading: t["status"] == "loading",
            group: i(t, "groupId"),
            last: t["lastAccessed"].as_f64().unwrap_or(0.0),
            owner: t["owner"].as_str().map(String::from),
        })
        .collect();
    let win_pos = |id: i64| windows.iter().position(|w| w.id == id).unwrap_or(usize::MAX);
    tabs.sort_by_key(|t| (win_pos(t.window), t.index));
    Ok(Snap { tabs, groups, windows })
}

// ---- peeks -----------------------------------------------------------------

/// What a tab shows: the last screenshot of it.
pub struct Peek {
    pub tab: i64,
    /// Bumped per answer, so the preview knows to redraw.
    pub seq: u64,
    pub error: Option<String>,
    pub thumb: Option<Thumb>,
}

pub struct Thumb {
    /// Its size in pixels (0 for `Same`, until the copy it stands for is found).
    pub w: usize,
    pub h: usize,
    /// When it was taken (ms since the epoch).
    pub at: f64,
    /// When the picture last changed: a re-take of an unchanged page keeps it.
    pub rev: f64,
    /// The box it was asked to fit, in pixels.
    pub fit: (u16, u16),
    pub px: Pixels,
}

pub enum Pixels {
    /// Raw RGB, for half blocks.
    Rgb(Vec<u8>),
    /// A PNG (base64), for a terminal that draws images (see gfx.rs).
    Png(String),
    /// The extension's answer to `have`: the copy ctab holds is still the latest.
    Same,
}

pub struct PeekReq {
    pub tab: i64,
    /// The thumbnail's box, in pixels: a cell's real size when the terminal
    /// draws images, one pixel wide and two tall for half blocks.
    pub w: u16,
    pub h: u16,
    /// A PNG instead of raw RGB.
    pub png: bool,
    /// The `rev` of the screenshot ctab already holds for this tab and box.
    pub have: Option<f64>,
}

/// A thread that answers peeks, newest request first: holding j through the
/// list asks for every tab, but only the one you stop on gets read.
pub fn peek_worker(host: Host) -> (Sender<PeekReq>, Receiver<Peek>) {
    let (req_tx, req_rx) = mpsc::channel::<PeekReq>();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut seq = 0;
        while let Ok(mut r) = req_rx.recv() {
            while let Ok(newer) = req_rx.try_recv() {
                r = newer;
            }
            seq += 1;
            let fmt = if r.png { "png" } else { "rgb" };
            let args = json!({ "tab": r.tab, "w": r.w, "h": r.h, "fmt": fmt, "have": r.have });
            let p = match host.call("switcher.peek", args, Duration::from_secs(4)) {
                Ok(v) => Peek {
                    tab: r.tab,
                    seq,
                    error: v["error"].as_str().map(String::from),
                    thumb: thumb(&v["thumb"], (r.w, r.h)),
                },
                Err(e) => Peek { tab: r.tab, seq, error: Some(e), thumb: None },
            };
            if tx.send(p).is_err() {
                break;
            }
        }
    });
    (req_tx, rx)
}

fn thumb(v: &Value, fit: (u16, u16)) -> Option<Thumb> {
    let at = v["at"].as_f64().unwrap_or(0.0);
    let rev = v["rev"].as_f64().unwrap_or(at);
    if v["same"].as_bool() == Some(true) {
        return Some(Thumb { w: 0, h: 0, at, rev, fit, px: Pixels::Same });
    }
    let w = v["w"].as_u64()? as usize;
    let h = v["h"].as_u64()? as usize;
    if w == 0 || h == 0 {
        return None;
    }
    if let Some(png) = v["png"].as_str().filter(|p| !p.is_empty()) {
        return Some(Thumb { w, h, at, rev, fit, px: Pixels::Png(png.to_string()) });
    }
    let rgb = base64(v["rgb"].as_str()?)?;
    let ok = rgb.len() == w * h * 3;
    ok.then_some(Thumb { w, h, at, rev, fit, px: Pixels::Rgb(rgb) })
}

fn base64(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = (match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return None,
        }) as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::base64;

    #[test]
    fn decodes() {
        assert_eq!(base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(base64("AAEC/w==").unwrap(), [0, 1, 2, 255]);
        assert_eq!(base64("").unwrap(), b"");
    }
}
