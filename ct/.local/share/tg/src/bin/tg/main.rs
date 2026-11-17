//! tg — chrome tab groups. Every tab group in one box: the open ones and the closed ones Chrome
//! keeps on its bookmarks bar, each with its tabs, for removing the ones you don't need. `;`
//! removes the group under the cursor, or every marked group. Open groups are ungrouped (their
//! tabs stay open, `u` regroups them); closed ones are deleted from Chrome for good, through
//! Chrome's own menu, so `;` asks a second time first. ct's sibling: same keys, same box.

mod ax;
mod model;
mod remove;
mod store;

use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::ops::RangeInclusive;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant, SystemTime};

use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Clear, Widget};
use ratatui::{DefaultTerminal, Terminal};
use unicode_width::UnicodeWidthStr;

use tabkit::bridge::{self, Host, Snap};
use tabkit::text::{age_label, fg, now_ms, put, truncate};
use tabkit::theme::{self, Palette};

use model::Group;
use remove::Job;

const HELP: &str = "\
tg — chrome tab groups: every group, open or closed, with its tabs; remove what you don't need

usage:
  tg                   open the list
  tg ls [-v]           print every group and its key (-v: its tabs too)
  tg rm KEY…           remove groups by key (`tg ls`; 8 characters are enough), no questions

move:
  j k  ↓ ↑             next / previous (5j, 3k: counts, by the relative numbers)
  ^d ^u                half a list down / up
  g G  12G             first / last / group 12

remove:
  ; x                  remove the group, every marked group, or the visual range
                       open: ungrouped, its tabs stay open (u regroups them)
                       closed: deleted from Chrome for good, so ; asks again
  space m              mark / unmark, then move down
  v                    visual: j/k stretch a range; ; removes it, space marks it
  D                    mark duplicates: same name and color (keeps the open one, else the newest)
  a                    mark everything shown (after / : every match)
  u                    regroup what the last ungroup took apart

view:
  /                    filter by group name, tab title or URL (⏎ keeps it, esc drops it)
  ?                    these keys
  esc                  leave visual / clear marks / drop the filter / quit
  q                    quit

options:
  --browser NAME       pick a connected browser when several are (also $BROWSER_USE_BROWSER)
  --profile DIR        the Chrome profile directory (Default, Profile 1); default: the last used
  -h, --help

Closed groups exist only on Chrome's bookmarks bar, out of the extension's reach, so tg deletes
them through Chrome's own chip menu (macOS accessibility, in a New Tab window it brings to the
front while it works, with the bookmarks bar shown for the run if Chrome hides it there). It
opens the menu, checks it lists exactly the group's tabs, and only then presses Delete group (and
Delete Group when Chrome asks first). Groups unpinned from the bar can't be reached; tg lists
them apart.
";

/// Open groups re-read this often; the store whenever Chrome writes to it.
const REFRESH: Duration = Duration::from_millis(1000);
const FLASH: Duration = Duration::from_secs(4);
const MAX_W: u16 = 170;
const UNDO_DEPTH: usize = 50;

fn main() -> ExitCode {
    let mut browser = std::env::var("BROWSER_USE_BROWSER").ok().filter(|s| !s.is_empty());
    let mut profile: Option<String> = None;
    let mut snapshot: Option<(u16, u16)> = None;
    let mut keys = String::new();
    let mut cmd: Option<String> = None;
    let mut verbose = false;
    let mut rest: Vec<String> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "-h" | "--help" => {
                print!("{HELP}");
                return ExitCode::SUCCESS;
            }
            "ls" | "rm" if cmd.is_none() => cmd = Some(a),
            "-v" | "--verbose" => verbose = true,
            "--browser" => browser = args.next(),
            "--profile" => profile = args.next(),
            // Hidden: render one frame as plain text, after pressing --keys. Nothing is removed.
            "--snapshot" => {
                snapshot = args.next().and_then(|v| {
                    let (w, h) = v.split_once('x')?;
                    Some((w.parse().ok()?, h.parse().ok()?))
                });
                if snapshot.is_none() {
                    eprintln!("tg: --snapshot needs WxH");
                    return ExitCode::from(2);
                }
            }
            "--keys" => keys = args.next().unwrap_or_default(),
            _ if cmd.as_deref() == Some("rm") && !a.starts_with('-') => rest.push(a),
            _ => {
                eprintln!("tg: unknown argument {a} (tg -h)");
                return ExitCode::from(2);
            }
        }
    }
    let src = match Source::open(browser.as_deref(), profile.as_deref()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("tg: {e}");
            return ExitCode::FAILURE;
        }
    };
    match cmd.as_deref() {
        Some("ls") => return print_list(&src, verbose),
        Some("rm") => return remove_cli(&src, &rest),
        _ => {}
    }
    let mut app = match App::new(src, theme::palette()) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("tg: {e}");
            return ExitCode::FAILURE;
        }
    };
    let res = match snapshot {
        Some((w, h)) => snapshot_frame(&mut app, w, h, &parse_keys(&keys)),
        None => run(&mut app),
    };
    match res {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("tg: {e}");
            ExitCode::FAILURE
        }
    }
}

// ---- where groups come from --------------------------------------------------------

/// The browser (extension) and its profile's sync store.
struct Source {
    host: Host,
    /// The browser's process, for accessibility.
    pid: Option<i32>,
    store: PathBuf,
    /// tg's copy of the store, rewritten on every read.
    scratch: PathBuf,
}

impl Source {
    fn open(browser: Option<&str>, profile: Option<&str>) -> Result<Source, String> {
        let host = bridge::pick(browser)?;
        let pid = host.pid.and_then(ax::browser_pid);
        let exe = pid.and_then(ax::exe_of).ok_or("couldn't find the browser's process")?;
        let store = store::locate(&exe, profile)?;
        let scratch = std::env::temp_dir().join(format!("tg-store-{}", std::process::id()));
        Ok(Source { host, pid, store, scratch })
    }

    fn read(&self) -> Result<(Vec<store::SavedGroup>, Snap), String> {
        let snap = bridge::list(&self.host)?;
        let saved = store::read(&self.store, &self.scratch)?;
        Ok((saved, snap))
    }
}

impl Drop for Source {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.scratch);
    }
}

/// `tg ls`: one line per group, its tabs under it with -v.
fn print_list(src: &Source, verbose: bool) -> ExitCode {
    let (saved, snap) = match src.read() {
        Ok(x) => x,
        Err(e) => {
            eprintln!("tg: {e}");
            return ExitCode::FAILURE;
        }
    };
    let clean = |s: &str| s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>();
    let mut out = String::new();
    for g in model::merge(saved, &snap) {
        let state = if g.is_open() {
            "open"
        } else if g.pinned.is_some() {
            "closed"
        } else {
            "closed, not on the bar"
        };
        let title = if g.title.is_empty() { "(unnamed)".to_string() } else { clean(&g.title) };
        out.push_str(&format!("{}\t{state}\t{}\t{title}\t{} tab{}\n", g.key, g.color, g.tabs.len(), if g.tabs.len() == 1 { "" } else { "s" }));
        if verbose {
            for t in &g.tabs {
                out.push_str(&format!("\t\t{}\t{}\n", clean(t.label()), t.url));
            }
        }
    }
    let _ = io::stdout().lock().write_all(out.as_bytes());
    ExitCode::SUCCESS
}

/// The removal each group needs: ungroup an open one, delete a closed one.
fn job_for(g: &Group) -> Job {
    match g.open {
        Some(_) => Job::Ungroup { key: g.key.clone(), title: g.title.clone(), color: g.color.clone(), tabs: g.tabs.iter().filter_map(|t| t.id).collect() },
        None => Job::Delete { key: g.key.clone(), title: g.title.clone(), tabs: g.tabs.iter().map(|t| t.label().to_string()).collect() },
    }
}

/// Testing aid: with TG_ONLY=prefix set, only groups named with it (or unnamed ones whose every
/// tab URL has it) are ever removed.
fn allowed(g: &Group) -> bool {
    std::env::var("TG_ONLY").map_or(true, |p| {
        g.title.starts_with(&p) || (g.title.is_empty() && !g.tabs.is_empty() && g.tabs.iter().all(|t| t.url.contains(&p)))
    })
}

/// `tg rm KEY…`
fn remove_cli(src: &Source, keys: &[String]) -> ExitCode {
    if keys.is_empty() {
        eprintln!("tg rm: which groups? (`tg ls` prints their keys)");
        return ExitCode::from(2);
    }
    let groups = match src.read() {
        Ok((saved, snap)) => model::merge(saved, &snap),
        Err(e) => {
            eprintln!("tg: {e}");
            return ExitCode::FAILURE;
        }
    };
    let mut jobs = Vec::new();
    let mut names: HashMap<String, String> = HashMap::new();
    for k in keys {
        let hits: Vec<&Group> = groups.iter().filter(|g| g.key == *k || (k.len() >= 8 && g.key.starts_with(k.as_str()))).collect();
        match hits[..] {
            [g] if !allowed(g) => {
                eprintln!("tg rm: {k} ({}) isn't allowed by TG_ONLY", g.title);
                return ExitCode::from(2);
            }
            [g] => {
                names.insert(g.key.clone(), g.label());
                jobs.push(job_for(g));
            }
            [] => {
                eprintln!("tg rm: no group {k}");
                return ExitCode::from(2);
            }
            _ => {
                eprintln!("tg rm: {k} matches {} groups; give more of the key", hits.len());
                return ExitCode::from(2);
            }
        }
    }
    let (tx, rx) = mpsc::channel();
    let (host, pid) = (src.host.clone(), src.pid);
    std::thread::spawn(move || remove::run(host, pid, jobs, tx));
    let mut failed = false;
    let name = |k: &str| names.get(k).cloned().unwrap_or_else(|| k.to_string());
    for ev in rx {
        match ev {
            remove::Event::Working { .. } => {}
            remove::Event::Ungrouped { key, tabs, .. } => println!("ungrouped {} ({} tabs stay open)", name(&key), tabs.len()),
            remove::Event::Deleted { key } => println!("deleted {}", name(&key)),
            remove::Event::Failed { key, why } => {
                failed = true;
                eprintln!("{}: {why}", name(&key));
            }
            remove::Event::Stopped { why, left } => {
                failed = true;
                eprintln!("stopped: {why}");
                for k in left {
                    eprintln!("  left alone: {}", name(&k));
                }
            }
            remove::Event::Warn { why } => {
                failed = true;
                eprintln!("{why}");
            }
            remove::Event::Finished => break,
        }
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

// ---- the box -------------------------------------------------------------------

fn run(app: &mut App) -> io::Result<()> {
    let mut terminal = ratatui::init();
    let res = event_loop(&mut terminal, app);
    ratatui::restore();
    res
}

fn event_loop(terminal: &mut DefaultTerminal, app: &mut App) -> io::Result<()> {
    let mut dirty = true;
    loop {
        dirty |= app.tick();
        if app.quit_after && app.busy.is_none() {
            return Ok(());
        }
        if dirty {
            terminal.draw(|f| {
                let area = f.area();
                draw(app, area, f.buffer_mut());
            })?;
            dirty = false;
        }
        if !event::poll(Duration::from_millis(100))? {
            continue;
        }
        loop {
            if let Event::Key(k) = event::read()? {
                if k.kind != KeyEventKind::Release && app.key(k) {
                    return Ok(());
                }
            }
            dirty = true;
            if !event::poll(Duration::ZERO)? {
                break;
            }
        }
    }
}

fn snapshot_frame(app: &mut App, w: u16, h: u16, keys: &[KeyEvent]) -> io::Result<()> {
    app.live = false;
    let mut term = Terminal::new(TestBackend::new(w, h)).map_err(io::Error::other)?;
    let mut frame = |app: &mut App| {
        term.draw(|f| {
            let area = f.area();
            draw(app, area, f.buffer_mut());
        })
        .map(|_| ())
        .map_err(io::Error::other)
    };
    frame(app)?;
    for &k in keys {
        if app.key(k) {
            break;
        }
        frame(app)?;
    }
    let buf = term.backend().buffer();
    for y in 0..h {
        let row: String = (0..w).map(|x| buf[(x, y)].symbol().to_string()).collect();
        println!("{}", row.trim_end());
    }
    Ok(())
}

/// `jj v j<esc>` → keys. `<esc> <cr> <bs> <up> <down> <space> <c-x>`; anything else is itself.
fn parse_keys(s: &str) -> Vec<KeyEvent> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(c) = rest.chars().next() {
        if c == '<' {
            if let Some(end) = rest.find('>') {
                let name = &rest[1..end];
                let key = match name {
                    "esc" => Some(KeyEvent::from(KeyCode::Esc)),
                    "cr" => Some(KeyEvent::from(KeyCode::Enter)),
                    "bs" => Some(KeyEvent::from(KeyCode::Backspace)),
                    "up" => Some(KeyEvent::from(KeyCode::Up)),
                    "down" => Some(KeyEvent::from(KeyCode::Down)),
                    "space" => Some(KeyEvent::from(KeyCode::Char(' '))),
                    _ => name
                        .strip_prefix("c-")
                        .and_then(|k| k.chars().next().filter(|_| k.chars().count() == 1))
                        .map(|k| KeyEvent::new(KeyCode::Char(k), KeyModifiers::CONTROL)),
                };
                if let Some(k) = key {
                    out.push(k);
                    rest = &rest[end + 1..];
                    continue;
                }
            }
        }
        out.push(KeyEvent::from(KeyCode::Char(c)));
        rest = &rest[c.len_utf8()..];
    }
    out
}

// ---- state -------------------------------------------------------------------

enum Row {
    Header(String),
    Group(usize),
}

/// What an ungroup took apart: `u` puts it back.
struct Ungrouped {
    title: String,
    color: String,
    tabs: Vec<i64>,
}

/// A removal run in progress.
struct Busy {
    keys: HashSet<String>,
    current: Option<String>,
    n: usize,
    of: usize,
    deleted: usize,
    ungrouped: usize,
    failed: Vec<String>,
    stopped: Option<String>,
}

enum Note {
    Remove(remove::Event),
    Regrouped(Result<i64, String>, Ungrouped),
}

struct App {
    src: Source,
    pal: Palette,
    groups: Vec<Group>,
    /// Groups shown, as indices into `groups`.
    view: Vec<usize>,
    rows: Vec<Row>,
    cur: usize,
    top: usize,
    list_h: usize,
    /// The most rows the box has had: it never shrinks, so removing groups doesn't re-center it.
    tall: usize,
    count: Option<u32>,
    marks: HashSet<String>,
    /// Visual mode's other end (a group key).
    visual: Option<String>,
    query: String,
    typing: bool,
    help: bool,
    /// The groups a second `;` deletes for good.
    confirm: Option<Vec<String>>,
    busy: Option<Busy>,
    /// Removed here and not yet gone from Chrome's lists.
    gone: HashSet<String>,
    undo: Vec<Ungrouped>,
    /// The message, and whether it's bad news.
    msg: Option<(String, Instant, bool)>,
    tx: Sender<Note>,
    rx: Receiver<Note>,
    fetched: Instant,
    stamp: Option<SystemTime>,
    saved: Vec<store::SavedGroup>,
    live: bool,
    /// Asked to quit during a removal.
    quit_after: bool,
}

impl App {
    fn new(src: Source, pal: Palette) -> Result<App, String> {
        let (saved, snap) = src.read()?;
        let stamp = store::stamp(&src.store);
        let (tx, rx) = mpsc::channel();
        let mut app = App {
            src,
            pal,
            groups: Vec::new(),
            view: Vec::new(),
            rows: Vec::new(),
            cur: 0,
            top: 0,
            list_h: 1,
            tall: 0,
            count: None,
            marks: HashSet::new(),
            visual: None,
            query: String::new(),
            typing: false,
            help: false,
            confirm: None,
            busy: None,
            gone: HashSet::new(),
            undo: Vec::new(),
            msg: None,
            tx,
            rx,
            fetched: Instant::now(),
            stamp,
            saved: Vec::new(),
            live: true,
            quit_after: false,
        };
        app.set_groups(saved, &snap, None);
        Ok(app)
    }

    fn group(&self, k: usize) -> &Group {
        &self.groups[self.view[k]]
    }

    fn selected_key(&self) -> Option<String> {
        self.view.get(self.cur).map(|&i| self.groups[i].key.clone())
    }

    fn pos(&self, key: &str) -> Option<usize> {
        self.view.iter().position(|&i| self.groups[i].key == key)
    }

    fn keys(&self, ks: impl IntoIterator<Item = usize>) -> Vec<String> {
        ks.into_iter().filter(|&k| k < self.view.len()).map(|k| self.group(k).key.clone()).collect()
    }

    fn visual_range(&self) -> Option<RangeInclusive<usize>> {
        let anchor = self.visual.as_ref()?;
        if self.view.is_empty() {
            return None;
        }
        let a = self.pos(anchor).unwrap_or(self.cur);
        Some(a.min(self.cur)..=a.max(self.cur))
    }

    fn flash(&mut self, m: impl Into<String>) {
        self.msg = Some((m.into(), Instant::now(), false));
    }

    fn alert(&mut self, m: impl Into<String>) {
        self.msg = Some((m.into(), Instant::now(), true));
    }

    fn set_groups(&mut self, saved: Vec<store::SavedGroup>, snap: &Snap, focus: Option<String>) {
        let keep = focus.or_else(|| self.selected_key());
        // Keep the store's groups for the next merge (a re-read of open groups alone).
        let merged = model::merge(clone_saved(&saved), snap);
        self.saved = saved;
        let present: HashSet<&str> = merged.iter().map(|g| g.key.as_str()).collect();
        self.gone.retain(|k| present.contains(k.as_str()));
        self.marks.retain(|k| present.contains(k.as_str()));
        if self.visual.as_ref().is_some_and(|k| !present.contains(k.as_str())) {
            self.visual = None;
        }
        self.groups = merged;
        self.set_view(keep);
    }

    /// Recompute what's shown, keeping the cursor on group `keep` when it's still there.
    fn set_view(&mut self, keep: Option<String>) {
        let words: Vec<String> = self.query.split_whitespace().map(str::to_lowercase).collect();
        self.view = (0..self.groups.len()).filter(|&i| !self.gone.contains(&self.groups[i].key) && self.groups[i].matches(&words)).collect();
        let at = keep.and_then(|k| self.pos(&k));
        self.cur = at.unwrap_or(self.cur).min(self.view.len().saturating_sub(1));
    }

    /// Re-read the open groups, and the store when Chrome has written to it.
    fn refresh(&mut self) {
        self.fetched = Instant::now();
        let snap = match bridge::list(&self.src.host) {
            Ok(s) => s,
            Err(e) => return self.alert(e),
        };
        let stamp = store::stamp(&self.src.store);
        let saved = if stamp != self.stamp {
            match store::read(&self.src.store, &self.src.scratch) {
                Ok(s) => {
                    self.stamp = stamp;
                    s
                }
                Err(e) => {
                    self.alert(e);
                    clone_saved(&self.saved)
                }
            }
        } else {
            clone_saved(&self.saved)
        };
        self.set_groups(saved, &snap, None);
    }

    fn tick(&mut self) -> bool {
        let mut dirty = false;
        while let Ok(note) = self.rx.try_recv() {
            dirty = true;
            match note {
                Note::Remove(ev) => self.on_event(ev),
                Note::Regrouped(Ok(_), u) => {
                    self.flash(format!("regrouped {} ({} tabs)", if u.title.is_empty() { "the group" } else { &u.title }, u.tabs.len()));
                    self.refresh();
                }
                Note::Regrouped(Err(e), u) => {
                    self.undo.push(u);
                    self.alert(format!("couldn't regroup: {e}"));
                }
            }
        }
        if self.msg.as_ref().is_some_and(|(_, at, _)| at.elapsed() > FLASH) && self.busy.is_none() {
            self.msg = None;
            dirty = true;
        }
        if self.live && self.fetched.elapsed() > REFRESH {
            self.refresh();
            dirty = true;
        }
        dirty
    }

    fn on_event(&mut self, ev: remove::Event) {
        let Some(b) = self.busy.as_mut() else { return };
        match ev {
            remove::Event::Working { key, n, of } => {
                b.current = Some(key);
                b.n = n;
                b.of = of;
            }
            remove::Event::Ungrouped { key, title, color, tabs } => {
                b.ungrouped += 1;
                b.keys.remove(&key);
                self.gone.insert(key);
                self.undo.push(Ungrouped { title, color, tabs });
                if self.undo.len() > UNDO_DEPTH {
                    self.undo.remove(0);
                }
            }
            remove::Event::Deleted { key } => {
                b.deleted += 1;
                b.keys.remove(&key);
                self.gone.insert(key);
            }
            remove::Event::Failed { key, why } => {
                b.keys.remove(&key);
                b.failed.push(why);
            }
            remove::Event::Stopped { why, left } => {
                for k in left {
                    b.keys.remove(&k);
                }
                b.stopped = Some(why);
            }
            remove::Event::Warn { why } => b.failed.push(why),
            remove::Event::Finished => {
                let b = self.busy.take().unwrap();
                let mut parts = Vec::new();
                if b.deleted > 0 {
                    parts.push(format!("deleted {}", b.deleted));
                }
                if b.ungrouped > 0 {
                    parts.push(format!("ungrouped {} · u regroups", b.ungrouped));
                }
                let summary = parts.join(" · ");
                match (b.stopped, b.failed.first()) {
                    (Some(why), _) => self.alert(if summary.is_empty() { format!("stopped: {why}") } else { format!("{summary} · stopped: {why}") }),
                    (None, Some(why)) => {
                        let more = if b.failed.len() > 1 { format!(" (+{} more)", b.failed.len() - 1) } else { String::new() };
                        self.alert(if summary.is_empty() { format!("{why}{more}") } else { format!("{summary} · {why}{more}") })
                    }
                    (None, None) => self.flash(if summary.is_empty() { "nothing to remove".to_string() } else { summary }),
                }
                // Chrome writes the store a moment later; re-read it then.
                self.stamp = None;
            }
        }
        let keep = self.selected_key();
        self.set_view(keep);
    }

    /// Quit now, or once a removal that's running has finished (it has a window and maybe a
    /// Chrome menu to put away).
    fn quit(&mut self) -> bool {
        if self.busy.is_none() {
            return true;
        }
        self.quit_after = true;
        self.flash("quitting when the removal finishes");
        false
    }

    fn key(&mut self, k: KeyEvent) -> bool {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && k.code == KeyCode::Char('c') {
            return self.quit();
        }
        if self.help {
            self.help = false;
            return false;
        }
        if self.typing {
            self.filter_key(k, ctrl);
            return false;
        }
        // A pending delete: ; (or y, ⏎) goes ahead, anything else calls it off.
        if let Some(keys) = self.confirm.take() {
            if matches!(k.code, KeyCode::Char(';' | 'x' | 'y') | KeyCode::Enter) {
                self.start(keys);
            } else {
                self.flash("kept them");
            }
            return false;
        }
        if let KeyCode::Char(c @ '0'..='9') = k.code {
            if !ctrl && (c != '0' || self.count.is_some()) {
                self.count = Some((self.count.unwrap_or(0) * 10 + (c as u32 - '0' as u32)).min(99_999));
                return false;
            }
        }
        let count = self.count.take();
        let n = count.unwrap_or(1).max(1) as usize;
        let half = (self.list_h as isize / 2).max(1);
        match k.code {
            KeyCode::Esc if count.is_some() => {}
            KeyCode::Esc => {
                if self.escape() {
                    return self.quit();
                }
            }
            KeyCode::Char('q') => return self.quit(),
            KeyCode::Char('d') if ctrl => self.move_by(half),
            KeyCode::Char('u') if ctrl => self.move_by(-half),
            KeyCode::Char('n') if ctrl => self.move_by(n as isize),
            KeyCode::Char('p') if ctrl => self.move_by(-(n as isize)),
            _ if ctrl => {}
            KeyCode::Char('j') | KeyCode::Down => self.move_by(n as isize),
            KeyCode::Char('k') | KeyCode::Up => self.move_by(-(n as isize)),
            KeyCode::Char('g' | 'G') | KeyCode::Home | KeyCode::End if count.is_some() => self.move_by(n as isize - 1 - self.cur as isize),
            KeyCode::Char('g') | KeyCode::Home => self.move_by(isize::MIN),
            KeyCode::Char('G') | KeyCode::End => self.move_by(isize::MAX),
            KeyCode::Char(';' | 'x') => self.remove(n),
            KeyCode::Char(' ' | 'm') => self.mark(n),
            KeyCode::Char('v') => self.visual = if self.visual.is_some() { None } else { self.selected_key() },
            KeyCode::Char('D') => self.mark_dups(),
            KeyCode::Char('a') => self.mark_all(),
            KeyCode::Char('u') => self.regroup(),
            KeyCode::Char('/') => {
                self.typing = true;
                self.visual = None;
            }
            KeyCode::Char('?') => self.help = true,
            _ => {}
        }
        false
    }

    fn escape(&mut self) -> bool {
        if self.visual.take().is_some() {
            return false;
        }
        if !self.marks.is_empty() {
            self.marks.clear();
            return false;
        }
        if !self.query.is_empty() {
            self.query.clear();
            let keep = self.selected_key();
            self.set_view(keep);
            return false;
        }
        true
    }

    fn filter_key(&mut self, k: KeyEvent, ctrl: bool) {
        match k.code {
            KeyCode::Esc => {
                self.typing = false;
                self.query.clear();
                let keep = self.selected_key();
                self.set_view(keep);
                return;
            }
            KeyCode::Enter | KeyCode::Tab => {
                self.typing = false;
                return;
            }
            KeyCode::Down => return self.move_by(1),
            KeyCode::Up => return self.move_by(-1),
            KeyCode::Char('n') if ctrl => return self.move_by(1),
            KeyCode::Char('p') if ctrl => return self.move_by(-1),
            KeyCode::Backspace => {
                if self.query.pop().is_none() {
                    self.typing = false;
                    return;
                }
            }
            KeyCode::Char('u') if ctrl => self.query.clear(),
            KeyCode::Char('w') if ctrl => {
                let end = self.query.trim_end().len();
                self.query.truncate(end);
                let cut = self.query.rfind(' ').map_or(0, |i| i + 1);
                self.query.truncate(cut);
            }
            KeyCode::Char(c) if !ctrl => self.query.push(c),
            _ => return,
        }
        self.set_view(None);
        self.cur = 0;
        self.top = 0;
    }

    fn move_by(&mut self, d: isize) {
        if self.view.is_empty() {
            return;
        }
        self.cur = (self.cur as isize).saturating_add(d).clamp(0, self.view.len() as isize - 1) as usize;
    }

    fn toggle_marks(&mut self, keys: &[String]) -> bool {
        if !keys.is_empty() && keys.iter().all(|k| self.marks.contains(k)) {
            for k in keys {
                self.marks.remove(k);
            }
            false
        } else {
            self.marks.extend(keys.iter().cloned());
            true
        }
    }

    fn mark(&mut self, n: usize) {
        if let Some(r) = self.visual_range() {
            self.visual = None;
            let keys = self.keys(r);
            self.toggle_marks(&keys);
            return;
        }
        for key in self.keys(self.cur..self.cur + n) {
            if !self.marks.remove(&key) {
                self.marks.insert(key);
            }
        }
        self.move_by(n as isize);
    }

    /// `D`: groups that look the same as another (name and color), except one of each: the open
    /// one, else the one changed last.
    fn mark_dups(&mut self) {
        let mut by_look: HashMap<(String, String), Vec<&Group>> = HashMap::new();
        for &i in &self.view {
            let g = &self.groups[i];
            by_look.entry(g.look()).or_default().push(g);
        }
        let mut keys = Vec::new();
        for same in by_look.values().filter(|s| s.len() > 1) {
            let keep = same.iter().max_by(|a, b| a.is_open().cmp(&b.is_open()).then(a.updated.total_cmp(&b.updated))).map(|g| g.key.clone());
            keys.extend(same.iter().map(|g| g.key.clone()).filter(|k| Some(k) != keep.as_ref()));
        }
        if keys.is_empty() {
            return self.flash("no duplicates");
        }
        let n = keys.len();
        if self.toggle_marks(&keys) {
            self.flash(format!("marked {n} duplicate{} (kept the open one, else the newest) · ; removes", if n == 1 { "" } else { "s" }));
        } else {
            self.flash("unmarked the duplicates");
        }
    }

    fn mark_all(&mut self) {
        let keys = self.keys(0..self.view.len());
        let n = keys.len();
        if self.toggle_marks(&keys) {
            self.flash(format!("marked all {n} · ; removes"));
        } else {
            self.flash("unmarked all");
        }
    }

    /// `;`: the visual range, else every marked group, else `n` groups from the cursor. Open
    /// groups go at once; a closed one in the lot means asking first.
    fn remove(&mut self, n: usize) {
        if self.busy.is_some() {
            return self.flash("still removing the last lot");
        }
        let keys = if let Some(r) = self.visual_range() {
            self.visual = None;
            self.keys(r)
        } else if !self.marks.is_empty() {
            self.groups.iter().filter(|g| self.marks.contains(&g.key) && !self.gone.contains(&g.key)).map(|g| g.key.clone()).collect()
        } else {
            self.keys(self.cur..self.cur + n)
        };
        if keys.is_empty() {
            return;
        }
        let closed = self.groups.iter().filter(|g| keys.contains(&g.key) && !g.is_open()).count();
        if closed > 0 {
            self.confirm = Some(keys);
        } else {
            self.start(keys);
        }
    }

    fn start(&mut self, keys: Vec<String>) {
        let targets: Vec<&Group> = self.groups.iter().filter(|g| keys.contains(&g.key)).collect();
        if let Some(g) = targets.iter().find(|g| !allowed(g)) {
            return self.alert(format!("TG_ONLY keeps “{}”", g.label()));
        }
        let jobs: Vec<Job> = targets.iter().map(|g| job_for(g)).collect();
        for k in &keys {
            self.marks.remove(k);
        }
        if !self.live {
            return;
        }
        self.busy = Some(Busy {
            keys: keys.iter().cloned().collect(),
            current: None,
            n: 0,
            of: jobs.len(),
            deleted: 0,
            ungrouped: 0,
            failed: Vec::new(),
            stopped: None,
        });
        let (host, pid, tx) = (self.src.host.clone(), self.src.pid, self.tx.clone());
        std::thread::spawn(move || {
            let (etx, erx) = mpsc::channel();
            std::thread::spawn(move || remove::run(host, pid, jobs, etx));
            for ev in erx {
                if tx.send(Note::Remove(ev)).is_err() {
                    break;
                }
            }
        });
    }

    fn regroup(&mut self) {
        let Some(u) = self.undo.pop() else {
            return self.flash("nothing to regroup (deleted groups can't come back)");
        };
        if !self.live {
            return;
        }
        let (host, tx) = (self.src.host.clone(), self.tx.clone());
        std::thread::spawn(move || {
            let r = host.group(&u.tabs, &u.title, &u.color);
            let _ = tx.send(Note::Regrouped(r, u));
        });
    }

    fn build_rows(&mut self) {
        self.rows.clear();
        let section = |g: &Group| {
            if g.is_open() {
                0
            } else if g.pinned.is_some() {
                1
            } else {
                2
            }
        };
        let mut n = [0usize; 3];
        for &i in &self.view {
            n[section(&self.groups[i])] += 1;
        }
        let names = ["open", "closed, on the bookmarks bar", "closed, not on the bar (tg can't reach these)"];
        let mut prev = None;
        for (k, &i) in self.view.iter().enumerate() {
            let s = section(&self.groups[i]);
            if prev != Some(s) {
                self.rows.push(Row::Header(format!("{} · {}", names[s], n[s])));
                prev = Some(s);
            }
            self.rows.push(Row::Group(k));
        }
    }

    /// The box, centered; whether the tabs go beside the list (else under it).
    fn layout(&mut self, area: Rect) -> (Rect, bool) {
        self.build_rows();
        let w = area.width.saturating_sub(4).min(MAX_W).max(area.width.min(24));
        let side = w >= 100;
        let most_tabs = self.view.iter().map(|&i| self.groups[i].tabs.len()).max().unwrap_or(0) + 1;
        let want = if side { self.rows.len().max(most_tabs) } else { self.rows.len() + 1 + most_tabs.min(12) };
        self.tall = self.tall.max(want).max(1);
        if self.help {
            self.tall = self.tall.max(help_lines().count());
        }
        let room = area.height.saturating_sub(2).max(area.height.min(3)) as usize;
        let inner_h = self.tall.min(room.saturating_sub(2)).max(1);
        self.list_h = if side { inner_h } else { self.rows.len().min(inner_h / 2).max(inner_h.min(3)) };
        let h = (inner_h as u16 + 2).min(area.height);
        let r = Rect::new(area.x + (area.width - w) / 2, area.y + (area.height - h) / 2, w, h);

        let row = self.rows.iter().position(|r| matches!(r, Row::Group(k) if *k == self.cur)).unwrap_or(0);
        let mut head = row;
        while head > 0 && matches!(self.rows[head - 1], Row::Header(..)) {
            head -= 1;
        }
        if head < self.top {
            self.top = head;
        }
        if row >= self.top + self.list_h {
            self.top = row + 1 - self.list_h;
        }
        self.top = self.top.min(self.rows.len().saturating_sub(self.list_h));
        (r, side)
    }
}

/// The store's groups, again (merging consumes them).
fn clone_saved(s: &[store::SavedGroup]) -> Vec<store::SavedGroup> {
    s.iter().map(store::SavedGroup::clone).collect()
}

fn help_lines() -> impl Iterator<Item = &'static str> {
    HELP.lines().skip_while(|l| !l.starts_with("move:")).take_while(|l| !l.starts_with("options:"))
}

// ---- drawing -----------------------------------------------------------------

fn draw(app: &mut App, area: Rect, buf: &mut Buffer) {
    let (r, side) = app.layout(area);
    let p = &app.pal;
    Clear.render(r, buf);
    let vis = app.visual_range();
    let open = app.view.iter().filter(|&&i| app.groups[i].is_open()).count();
    let shown = app.view.len();

    let mut head = format!(" {} · {shown} group{}", app.src.host.browser, if shown == 1 { "" } else { "s" });
    if shown > 0 {
        head.push_str(&format!(" · {open} open · {} closed", shown - open));
    }
    head.push(' ');
    let marked = if app.marks.is_empty() { String::new() } else { format!(" {} marked ", app.marks.len()) };
    let room = (r.width as usize).saturating_sub(4 + marked.width());
    let title = Line::from(vec![Span::styled(truncate(&head, room), fg(p.muted)), Span::styled(marked, fg(p.red).add_modifier(Modifier::BOLD))]);

    let room = r.width.saturating_sub(6) as usize;
    let hints = |pairs: &[(&str, &str)]| {
        let mut spans = Vec::new();
        let mut used = 1;
        for (k, l) in pairs {
            let (k, l) = (format!("  {k}"), format!(" {l}"));
            used += k.width() + l.width();
            if used > room {
                break;
            }
            spans.push(Span::styled(k, fg(p.muted)));
            spans.push(Span::styled(l, fg(p.dim)));
        }
        spans.push(Span::raw(" "));
        Line::from(spans).right_aligned()
    };
    let foot = if app.help {
        hints(&[("any key", "back to the groups")])
    } else if app.typing {
        Line::from(vec![
            Span::styled(" /", fg(p.accent)),
            Span::styled(app.query.clone(), fg(p.bright)),
            Span::styled("▏", fg(p.accent)),
            Span::styled(format!(" {} of {} ", app.view.len(), app.groups.len()), fg(p.dim)),
        ])
    } else if let Some(keys) = &app.confirm {
        let closed = app.groups.iter().filter(|g| keys.contains(&g.key) && !g.is_open()).count();
        let open = keys.len() - closed;
        let mut s = format!(" delete {closed} closed group{} from Chrome for good", if closed == 1 { "" } else { "s" });
        if open > 0 {
            s.push_str(&format!(" and ungroup {open}"));
        }
        s.push_str("? ");
        Line::from(vec![Span::styled(truncate(&s, room.saturating_sub(24)), fg(p.red).add_modifier(Modifier::BOLD)), Span::styled(" ; yes   any key no ", fg(p.muted))])
    } else if let Some(b) = &app.busy {
        let name = b.current.as_ref().and_then(|k| app.groups.iter().find(|g| &g.key == k)).map(|g| g.label()).unwrap_or_default();
        Line::from(Span::styled(format!(" removing {}/{} · {} ", b.n.max(1), b.of, truncate(&name, 40)), fg(p.yellow)))
    } else if let Some((m, _, bad)) = &app.msg {
        Line::from(Span::styled(format!(" {} ", truncate(m, room)), fg(if *bad { p.red } else { p.yellow })))
    } else if let Some(c) = app.count {
        Line::from(Span::styled(format!(" {c} "), fg(p.yellow)))
    } else if let Some(v) = &vis {
        let n = v.end() - v.start() + 1;
        hints(&[("visual", &format!("{n}")), (";", "remove them"), ("space", "mark them"), ("esc", "cancel")])
    } else if !app.marks.is_empty() {
        hints(&[(";", &format!("remove {}", app.marks.len())), ("esc", "unmark")])
    } else if !app.query.is_empty() {
        let mut l = hints(&[("a", "mark all"), (";", "remove"), ("esc", "drop filter")]);
        l.spans.insert(0, Span::styled(format!(" /{} · {} of {}", truncate(&app.query, 30), app.view.len(), app.groups.len()), fg(p.accent)));
        l
    } else {
        hints(&[("space", "mark"), (";", "remove"), ("D", "dupes"), ("u", "regroup"), ("/", "filter"), ("?", "keys")])
    };

    let block = Block::bordered().border_type(BorderType::Rounded).border_style(fg(p.border)).style(Style::new().bg(p.panel)).title(title).title_bottom(foot);
    let inner = block.inner(r);
    block.render(r, buf);

    let max = inner.right().saturating_sub(1);
    if app.help {
        for (i, l) in help_lines().enumerate().take(inner.height as usize) {
            let y = inner.y + i as u16;
            let chars: Vec<char> = l.chars().collect();
            if l.starts_with("  ") && chars.len() > 23 {
                let keys: String = chars[2..23].iter().collect();
                let what: String = chars[23..].iter().collect();
                put(buf, inner.x + 3, y, max, keys.trim_end(), fg(p.bright));
                put(buf, inner.x + 24, y, max, &what, fg(p.muted));
            } else {
                put(buf, inner.x + 1, y, max, l, fg(p.accent).add_modifier(Modifier::BOLD));
            }
        }
        return;
    }
    if app.view.is_empty() {
        let none = if app.query.is_empty() { "no tab groups".to_string() } else { format!("nothing matches “{}”", app.query) };
        put(buf, inner.x + 2, inner.y, max, &none, fg(p.dim));
        return;
    }

    // The list, and the cursor group's tabs beside it or under it.
    let (list, tabs) = if side {
        let lw = (inner.width * 2 / 5).clamp(36, 64);
        for y in inner.y..inner.bottom() {
            put(buf, inner.x + lw, y, inner.right(), "│", fg(p.border));
        }
        (Rect::new(inner.x, inner.y, lw, inner.height), Rect::new(inner.x + lw + 2, inner.y, inner.width.saturating_sub(lw + 3), inner.height))
    } else {
        let lh = (app.list_h as u16).min(inner.height);
        if lh < inner.height {
            put(buf, inner.x, inner.y + lh, inner.right(), &"─".repeat(inner.width as usize), fg(p.border));
        }
        let ty = inner.y + lh + 1;
        (Rect::new(inner.x, inner.y, inner.width, lh), Rect::new(inner.x + 1, ty, inner.width.saturating_sub(2), inner.bottom().saturating_sub(ty)))
    };
    let nw = app.view.len().to_string().len();
    let now = now_ms();
    for (i, row) in app.rows.iter().enumerate().skip(app.top).take(list.height as usize) {
        let y = list.y + (i - app.top) as u16;
        match row {
            Row::Header(text) => {
                put(buf, list.x + 1, y, list.right(), &truncate(text, list.width.saturating_sub(2) as usize), fg(p.muted).add_modifier(Modifier::BOLD));
            }
            Row::Group(k) => group_row(app, buf, list, y, *k, nw, vis.as_ref(), now),
        }
    }
    if let Some(&i) = app.view.get(app.cur) {
        tab_pane(app, &app.groups[i], buf, tabs, now);
    }
}

#[allow(clippy::too_many_arguments)]
fn group_row(app: &App, buf: &mut Buffer, list: Rect, y: u16, k: usize, nw: usize, vis: Option<&RangeInclusive<usize>>, now: f64) {
    let p = &app.pal;
    let g = app.group(k);
    let max = list.right();
    let on = k == app.cur;
    let busy = app.busy.as_ref().is_some_and(|b| b.keys.contains(&g.key));
    let armed = app.confirm.as_ref().is_some_and(|c| c.contains(&g.key));
    let doomed = armed || app.marks.contains(&g.key) || vis.is_some_and(|r| r.contains(&k));
    let row = Rect::new(list.x, y, list.width, 1);
    if on {
        buf.set_style(row, Style::new().bg(p.sel));
    } else if doomed {
        buf.set_style(row, Style::new().bg(p.doomed));
    }
    let gc = p.group(&g.color);
    put(buf, list.x, y, max, "▎", fg(gc));
    let (n, nst) = if on { (k + 1, fg(p.yellow).add_modifier(Modifier::BOLD)) } else { (k.abs_diff(app.cur), fg(p.dim)) };
    let x = put(buf, list.x + 1, y, max, &format!("{n:>nw$}"), nst) + 1;
    let (dot, dc) = if busy {
        ("…", p.yellow)
    } else if doomed {
        ("✕", p.red)
    } else if g.is_open() {
        ("●", p.green)
    } else {
        ("○", p.muted)
    };
    let x = put(buf, x, y, max, dot, fg(dc)) + 1;
    // Right side: tab count, and how long ago the group was made.
    let age = age_label(g.created, now);
    let right = format!("{:>3}  {:>3}", g.tabs.len(), age);
    let rx = max.saturating_sub(right.width() as u16 + 1);
    put(buf, rx, y, max, &right, fg(if on { p.muted } else { p.dim }));
    let room = rx.saturating_sub(x + 1) as usize;
    let mut st = if doomed { fg(p.red) } else { fg(gc) };
    if on {
        st = st.add_modifier(Modifier::BOLD);
    }
    if g.title.is_empty() {
        put(buf, x, y, rx, &truncate("unnamed", room), if doomed { fg(p.red) } else { fg(p.muted).add_modifier(Modifier::ITALIC) });
    } else {
        put(buf, x, y, rx, &truncate(&g.title, room), st);
    }
}

fn tab_pane(app: &App, g: &Group, buf: &mut Buffer, r: Rect, now: f64) {
    let p = &app.pal;
    if r.width < 8 || r.height == 0 {
        return;
    }
    let max = r.right();
    let name = g.label();
    let x = put(buf, r.x, r.y, max, &truncate(&name, r.width as usize / 2), fg(p.group(&g.color)).add_modifier(Modifier::BOLD));
    let mut facts = vec![format!("{} tab{}", g.tabs.len(), if g.tabs.len() == 1 { "" } else { "s" })];
    facts.push(if g.is_open() {
        "open".to_string()
    } else if g.pinned.is_some() {
        "closed, on the bar".to_string()
    } else {
        "closed, not on the bar".to_string()
    });
    if g.created > 0.0 {
        facts.push(format!("made {} ago", age_label(g.created, now)));
    }
    if g.guid.is_none() {
        facts.push("not saved".to_string());
    }
    put(buf, x, r.y, max, &truncate(&format!(" · {}", facts.join(" · ")), max.saturating_sub(x) as usize), fg(p.muted));
    let rows = r.height.saturating_sub(1) as usize;
    let many = g.tabs.len() > rows;
    let fit = if many { rows.saturating_sub(1) } else { rows };
    let w = r.width as usize;
    let title_w = if w >= 60 { w * 11 / 20 } else { w };
    for (i, t) in g.tabs.iter().take(fit).enumerate() {
        let y = r.y + 1 + i as u16;
        put(buf, r.x, y, max, &truncate(t.label(), title_w.saturating_sub(2)), fg(p.fg));
        if w >= 60 {
            put(buf, r.x + title_w as u16, y, max, &truncate(t.short_url(), w - title_w), fg(p.dim));
        }
    }
    if many {
        let y = r.y + 1 + fit as u16;
        put(buf, r.x, y, max, &format!("… {} more", g.tabs.len() - fit), fg(p.dim));
    }
}

