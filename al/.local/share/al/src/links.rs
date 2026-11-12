//! Links in the preview: web addresses, and code locations (`src/app.rs:42`,
//! `Read(~/x/y.py)`, a bare `README.md`) naming a file that's there in the
//! previewed tab's folder or its repo. They're underlined, and al wraps them
//! in OSC 8 hyperlinks carrying the whole target (main.rs), so a terminal
//! that opens hyperlinks itself opens all of one even where the preview cuts
//! it off, and finds a relative path in the tab's folder rather than al's. A
//! ctrl-click the terminal hands on to al opens here: a web link in the
//! browser, a file in Neovim in a floating Rex pane at its line.

use std::collections::HashMap;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::select;

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Target {
    Web(String),
    File { path: PathBuf, line: usize, col: usize },
}

impl Target {
    /// The hyperlink's target: the address, or the file as `file://…#L<line>:<col>`,
    /// the form nvim-links' open.py reads.
    pub fn uri(&self) -> String {
        match self {
            Target::Web(u) => u.clone(),
            Target::File { path, line, col } => format!("file://{}#L{line}:{col}", percent(&path.to_string_lossy())),
        }
    }
}

/// A link on line `line` of the preview, at cells `cols` of it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Link {
    pub line: usize,
    pub cols: Range<usize>,
    pub target: Target,
}

/// Finds links, remembering which names are files in which folder.
#[derive(Default)]
pub struct Finder {
    cwd: PathBuf,
    /// The folder's repo root, looked up the first time a name isn't in the folder itself.
    root: Option<Option<PathBuf>>,
    seen: HashMap<String, Option<PathBuf>>,
}

/// Most names looked up on disk per word: a long blob of JSON or quotes
/// shouldn't cost a frame.
const LOOKUPS: usize = 8;

impl Finder {
    /// Relative paths resolve in `cwd` (the previewed tab's folder), else its repo's root.
    pub fn set_cwd(&mut self, cwd: &Path) {
        if cwd != self.cwd || self.seen.len() > 20_000 {
            self.cwd = cwd.to_path_buf();
            self.root = None;
            self.seen.clear();
        }
    }

    /// The links in `s`, line `i` of the preview.
    pub fn find(&mut self, i: usize, s: &str, out: &mut Vec<Link>) {
        let (cs, width) = select::columns(s);
        let mut start = None;
        for (b, ch) in s.char_indices().chain([(s.len(), ' ')]) {
            if !ch.is_whitespace() {
                start.get_or_insert(b);
            } else if let Some(a) = start.take() {
                if let Some((r, target)) = self.word(&s[a..b]) {
                    let cols = select::col_of(&cs, width, a + r.start)..select::col_of(&cs, width, a + r.end);
                    out.push(Link { line: i, cols, target });
                }
            }
        }
    }

    /// The link in one whitespace-free word, as a byte range of it.
    fn word(&mut self, w: &str) -> Option<(Range<usize>, Target)> {
        if let Some(k) = w.find("https://").or_else(|| w.find("http://")) {
            let u = trim_url(&w[k..]);
            return (u.len() > "https://".len()).then(|| (k..k + u.len(), Target::Web(u.to_string())));
        }
        // A location starts the word, or follows an opener (`Read(src/a.rs)`,
        // `` `a.rs:3` ``, `path="x/y"`), and ends it or comes before a closer.
        let starts = std::iter::once(0).chain(w.char_indices().filter(|&(_, c)| OPENERS.contains(c)).map(|(k, c)| k + c.len_utf8()));
        let mut ends: Vec<usize> = w.char_indices().filter(|&(_, c)| CLOSERS.contains(c)).map(|(k, _)| k).collect();
        ends.push(w.len());
        ends.reverse();
        let mut lookups = 0;
        for a in starts {
            for &e in ends.iter().filter(|&&e| e > a) {
                // `@src/a.rs` is Claude's way of naming a file; a sentence's
                // punctuation and markdown's `**` aren't part of it.
                let raw = &w[a..e];
                let lead = raw.len() - raw.trim_start_matches(['@', '*']).len();
                let cand = raw[lead..].trim_end_matches(['.', ',', ':', ';', '!', '?', '*']);
                let a = a + lead;
                let (path, line, col) = location(cand);
                if !plausible(path) {
                    continue;
                }
                if !self.seen.contains_key(path) {
                    if lookups == LOOKUPS {
                        return None;
                    }
                    lookups += 1;
                }
                if let Some(file) = self.resolve(path) {
                    return Some((a..a + cand.len(), Target::File { path: file, line, col }));
                }
            }
        }
        None
    }

    /// `p` as a file: absolute, `~/…`, or in the folder or its repo.
    fn resolve(&mut self, p: &str) -> Option<PathBuf> {
        if let Some(v) = self.seen.get(p) {
            return v.clone();
        }
        let path = match p.strip_prefix("~/") {
            Some(rest) => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(rest),
            None => PathBuf::from(p),
        };
        let found = if path.is_absolute() {
            Some(path).filter(|f| f.is_file())
        } else {
            let here = self.cwd.join(&path);
            if here.is_file() {
                Some(here)
            } else {
                let root = self.root.get_or_insert_with(|| git_root(&self.cwd)).clone();
                root.map(|r| r.join(&path)).filter(|f| f.is_file())
            }
        };
        let found = found.map(|f| f.canonicalize().unwrap_or(f));
        self.seen.insert(p.to_string(), found.clone());
        found
    }
}

const OPENERS: &str = "([{<`'\"=";
const CLOSERS: &str = ")]}>`'\",;|";

/// `path[:line[:col]][-end]` → (path, line, col); no line is line 1.
fn location(s: &str) -> (&str, usize, usize) {
    let num = |x: &str| (!x.is_empty() && x.len() < 9 && x.bytes().all(|b| b.is_ascii_digit())).then(|| x.parse::<usize>().unwrap_or(1).max(1));
    // A range's end (`a.ts:12-19`) goes.
    let s = match s.rsplit_once('-') {
        Some((a, b)) if num(b).is_some() && a.rsplit_once(':').is_some_and(|(_, n)| num(n).is_some()) => a,
        _ => s,
    };
    if let Some((a, last)) = s.rsplit_once(':') {
        if let Some(n) = num(last) {
            return match a.rsplit_once(':') {
                Some((p, l)) if num(l).is_some() => (p, num(l).unwrap_or(1), n),
                _ => (a, n, 1),
            };
        }
    }
    (s, 1, 1)
}

/// Whether `p` could name a file: something with a `/` or an extension,
/// not a flag, an address or plain punctuation.
fn plausible(p: &str) -> bool {
    p.len() > 1
        && p.len() < 512
        && (p.contains('/') || p.contains('.'))
        && p.chars().any(char::is_alphanumeric)
        && !p.starts_with('-')
        && !p.contains("://")
}

/// A web address up to where it plainly ends: before quotes and brackets
/// that aren't its own, and the punctuation of the sentence around it.
fn trim_url(s: &str) -> &str {
    let mut s = &s[..s.find(['<', '>', '"', '\'', '`', '|']).unwrap_or(s.len())];
    loop {
        let t = s.trim_end_matches(['.', ',', ':', ';', '!', '?', '*']);
        let unbalanced = |open: char, close: char| t.ends_with(close) && t.matches(close).count() > t.matches(open).count();
        let t = if unbalanced('(', ')') || unbalanced('[', ']') { &t[..t.len() - 1] } else { t };
        if t.len() == s.len() {
            return s;
        }
        s = t;
    }
}

fn git_root(dir: &Path) -> Option<PathBuf> {
    let out = Command::new("git").arg("-C").arg(dir).args(["rev-parse", "--show-toplevel"]).stderr(Stdio::null()).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !s.is_empty()).then(|| s.into())
}

/// `s` with everything but unreserved characters and `/` percent-encoded.
fn percent(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Open `t` from al, for a ctrl-click the terminal handed on rather than
/// opening it itself: a web link in the browser, a file in Neovim in a
/// floating pane over al's tab (as Herdr's nvim-links popup did).
pub fn open(t: &Target) -> Result<(), String> {
    let out = match t {
        Target::Web(u) => Command::new("open").arg(u).stdin(Stdio::null()).output(),
        Target::File { path, line, col } => return crate::rex::nvim_popup(&path.to_string_lossy(), *line, *col),
    }
    .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { out.status.to_string() } else { err })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finder() -> Finder {
        let mut f = Finder::default();
        f.set_cwd(Path::new(env!("CARGO_MANIFEST_DIR")));
        f
    }

    fn links(s: &str) -> Vec<(String, Target)> {
        let mut out = Vec::new();
        finder().find(0, s, &mut out);
        out.into_iter().map(|l| (s.chars().skip(l.cols.start).take(l.cols.len()).collect(), l.target)).collect()
    }

    fn here(p: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(p).canonicalize().unwrap()
    }

    #[test]
    fn web_addresses_end_where_the_sentence_does() {
        let l = links("see (https://github.com/openai/codex/pull/12), and [x](https://a.io/b_(c)).");
        assert_eq!(l[0].1, Target::Web("https://github.com/openai/codex/pull/12".into()));
        assert_eq!(l[1].1, Target::Web("https://a.io/b_(c)".into()));
        assert_eq!(l[0].0, "https://github.com/openai/codex/pull/12");
    }

    #[test]
    fn code_locations_that_exist() {
        let file = |p: &str, line, col| Target::File { path: here(p), line, col };
        let l = links("→ app   src/app.rs:42 and `src/ui.rs:7:3`, Read(Cargo.toml) @src/main.rs:1-9.");
        assert_eq!(l.len(), 4, "{l:?}");
        assert_eq!(l[0], ("src/app.rs:42".into(), file("src/app.rs", 42, 1)));
        assert_eq!(l[1], ("src/ui.rs:7:3".into(), file("src/ui.rs", 7, 3)));
        assert_eq!(l[2], ("Cargo.toml".into(), file("Cargo.toml", 1, 1)));
        assert_eq!(l[3].1, file("src/main.rs", 1, 1));
        assert!(links("src/nope.rs:3 time:123 e.g. v0.1 -x/y ...").is_empty());
    }

    #[test]
    fn file_uris_are_what_open_py_reads() {
        let t = Target::File { path: "/tmp/a b;c.rs".into(), line: 4, col: 2 };
        assert_eq!(t.uri(), "file:///tmp/a%20b%3Bc.rs#L4:2");
    }
}
