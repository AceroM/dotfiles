//! The browser-use native host, straight over its unix socket: one JSON request
//! per connection. The host relays to the browser-use extension, whose
//! `switcher.*` commands (extension/switcher.js, shared with ctab) work on any
//! tab and never attach the debugger. tk only lists and closes.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
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
        writeln!(s, "{}", json!({ "cmd": cmd, "args": args, "owner": "tk" })).map_err(|e| format!("browser-use host: {e}"))?;
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).map_err(|e| format!("{cmd}: {e}"))?;
        let mut v: Value = serde_json::from_str(&line).map_err(|e| format!("{cmd}: {e}"))?;
        match v.get("error").and_then(Value::as_str) {
            Some(e) if e.starts_with("unknown command: switcher.") => {
                Err("the browser-use extension predates the switcher: run `browser-use reload`".to_string())
            }
            Some(e) => Err(e.to_string()),
            None => Ok(v["result"].take()),
        }
    }

    pub fn close(&self, id: i64) -> Result<(), String> {
        self.call("switcher.close", json!({ "tabs": [id] }), Duration::from_secs(3)).map(|_| ())
    }
}

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
    /// Unloaded by Chrome to save memory.
    pub discarded: bool,
    pub loading: bool,
    /// -1 when ungrouped.
    pub group: i64,
    /// When it was last the active tab (ms since the epoch).
    pub last: f64,
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
        })
        .collect();
    let win_pos = |id: i64| windows.iter().position(|w| w.id == id).unwrap_or(usize::MAX);
    tabs.sort_by_key(|t| (win_pos(t.window), t.index));
    Ok(Snap { tabs, groups, windows })
}
