//! ct — chrome tabs. Every browser tab in one list in the middle of the screen,
//! by title and URL, for deciding what stays and closing the rest fast. `;`
//! closes the tab under the cursor, or every marked tab, or a visual range.
//! Marks come from space, `*` (same site), `D` (duplicates) and `a` (whatever
//! a `/` filter shows). `u` reopens what was closed. No preview and no
//! switching (ctab does those).

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::ops::RangeInclusive;
use std::process::ExitCode;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Clear, Widget};
use ratatui::{DefaultTerminal, Terminal};
use unicode_width::UnicodeWidthStr;

use tabkit::bridge::{self, Gone, Host, Snap, Tab};
use tabkit::text::{age_label, fg, now_ms, put, truncate, truncate_left};
use tabkit::theme::{self, Palette};

const HELP: &str = "\
ct — chrome tabs: every browser tab by title and URL; close what you don't need

usage:
  ct                   open the list
  ct ls                print every tab as title<TAB>url, in tab-strip order

move:
  j k  ↓ ↑             next / previous (5j, 3k: counts, by the relative numbers)
  ^d ^u                half a list down / up
  g G  12G             first / last / tab 12

close:
  ; x                  close the tab (5x: five), or every marked tab, or the visual range
  space m              mark / unmark, then move down
  v                    visual: j/k stretch a range; ; closes it, space marks it
  *                    mark every tab on this site
  D                    mark duplicates (keeps the copy you used last)
  a                    mark everything shown (after / : every match)
  u                    reopen what the last close closed (again: the one before)

view:
  /                    filter by title and URL (⏎ keeps it, esc drops it)
  s                    order: tab strip → by site → least recently used
  ?                    these keys
  esc                  leave visual / clear marks / drop the filter / quit
  q                    quit

options:
  --browser NAME       pick a connected browser when several are (also $BROWSER_USE_BROWSER)
  -h, --help

Talks to the browser-use extension (`browser-use status`), like ctab and tk.
";

/// The list is re-read this often, so tabs opened or closed in Chrome show up.
const REFRESH: Duration = Duration::from_millis(1000);
const FLASH: Duration = Duration::from_secs(3);
/// The box is at most this wide.
const MAX_W: u16 = 160;
/// Closes `u` can still reopen.
const UNDO_DEPTH: usize = 50;

fn main() -> ExitCode {
    let mut browser = std::env::var("BROWSER_USE_BROWSER").ok().filter(|s| !s.is_empty());
    let mut snapshot: Option<(u16, u16)> = None;
    let mut keys = String::new();
    let mut ls = false;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "-h" | "--help" => {
                print!("{HELP}");
                return ExitCode::SUCCESS;
            }
            "ls" => ls = true,
            "--browser" => browser = args.next(),
            // Hidden: render one frame as plain text, for UI work without a terminal.
            "--snapshot" => {
                snapshot = args.next().and_then(|v| {
                    let (w, h) = v.split_once('x')?;
                    Some((w.parse().ok()?, h.parse().ok()?))
                });
                if snapshot.is_none() {
                    eprintln!("ct: --snapshot needs WxH");
                    return ExitCode::from(2);
                }
            }
            // Hidden, with --snapshot: keys to press first (`jj v j`, `<esc>`, `<c-d>`). Nothing
            // is closed or reopened.
            "--keys" => keys = args.next().unwrap_or_default(),
            _ => {
                eprintln!("ct: unknown argument {a} (ct -h)");
                return ExitCode::from(2);
            }
        }
    }
    let host = match bridge::pick(browser.as_deref()) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("ct: {e}");
            return ExitCode::FAILURE;
        }
    };
    if ls {
        return print_list(&host);
    }
    let mut app = match App::new(host, theme::palette()) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("ct: {e}");
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
            eprintln!("ct: {e}");
            ExitCode::FAILURE
        }
    }
}

/// `ct ls`: title<TAB>url per tab, for grep and friends.
fn print_list(host: &Host) -> ExitCode {
    let snap = match bridge::list(host) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("ct: {e}");
            return ExitCode::FAILURE;
        }
    };
    let mut out = String::new();
    for t in &snap.tabs {
        let title: String = t.display_title().chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
        out.push_str(&format!("{title}\t{}\n", t.url));
    }
    // A closed pipe (`ct ls | head`) is fine.
    let _ = io::stdout().lock().write_all(out.as_bytes());
    ExitCode::SUCCESS
}

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
        // Drain everything queued (a held j, a burst of ;) before redrawing.
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
    // Lay out before each key, so ^d/^u know the list's height as they would live.
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

/// A row of the list: a heading (window, tab group, site or age), or a tab (its place in `view`).
enum Row {
    Header(String, Color),
    Tab(usize),
}

#[derive(Clone, Copy, PartialEq)]
enum Order {
    /// Windows, then left to right, with window and tab-group headings.
    Strip,
    /// Grouped by site, the sites with the most tabs first.
    Site,
    /// The tabs you haven't looked at in longest first.
    Age,
}

impl Order {
    fn next(self) -> Order {
        match self {
            Order::Strip => Order::Site,
            Order::Site => Order::Age,
            Order::Age => Order::Strip,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Order::Strip => "tab strip",
            Order::Site => "by site",
            Order::Age => "least recently used first",
        }
    }
}

/// A close or a reopen that finished.
enum Done {
    Closed(Vec<Gone>, Result<(), String>),
    Reopened(Vec<Gone>, Result<(Vec<i64>, usize), String>),
}

struct App {
    host: Host,
    pal: Palette,
    snap: Snap,
    /// Tabs shown, as indices into `snap.tabs`, in the current order.
    view: Vec<usize>,
    rows: Vec<Row>,
    /// The selected tab's place in `view`.
    cur: usize,
    /// The first row the list shows.
    top: usize,
    /// Rows the list showed last frame (for ^d/^u).
    list_h: usize,
    /// The most rows the box has had: it never shrinks, so closing tabs
    /// doesn't re-center it and slide the list under your cursor.
    tall: usize,
    /// A vim count being typed (5j, 12G, 5x).
    count: Option<u32>,
    /// Closed here and not yet gone from Chrome's list.
    closed: HashSet<i64>,
    /// Tabs the next `;` closes.
    marks: HashSet<i64>,
    /// Visual mode's other end (a tab); the range runs from it to the cursor.
    visual: Option<i64>,
    /// The `/` filter: every word has to be in the title or the URL.
    query: String,
    /// Typing into the filter.
    typing: bool,
    order: Order,
    help: bool,
    /// How many open tabs share each URL (`Tab::dup_key`).
    dups: HashMap<String, usize>,
    /// Closes that worked, newest last: what `u` reopens.
    undo: Vec<Vec<Gone>>,
    msg: Option<(String, Instant)>,
    done_tx: Sender<Done>,
    done_rx: Receiver<Done>,
    fetched: Instant,
    /// False for --snapshot: nothing is closed, reopened or re-read.
    live: bool,
}

impl App {
    fn new(host: Host, pal: Palette) -> Result<App, String> {
        let snap = bridge::list(&host)?;
        let (done_tx, done_rx) = mpsc::channel();
        let mut app = App {
            host,
            pal,
            snap,
            view: Vec::new(),
            rows: Vec::new(),
            cur: 0,
            top: 0,
            list_h: 1,
            tall: 0,
            count: None,
            closed: HashSet::new(),
            marks: HashSet::new(),
            visual: None,
            query: String::new(),
            typing: false,
            order: Order::Strip,
            help: false,
            dups: HashMap::new(),
            undo: Vec::new(),
            msg: None,
            done_tx,
            done_rx,
            fetched: Instant::now(),
            live: true,
        };
        // Start on the tab you were last looking at.
        let here = app.snap.tabs.iter().filter(|t| t.active).max_by(|a, b| a.last.total_cmp(&b.last)).map(|t| t.id);
        app.set_view(here);
        Ok(app)
    }

    fn tab(&self, k: usize) -> &Tab {
        &self.snap.tabs[self.view[k]]
    }

    fn selected_id(&self) -> Option<i64> {
        self.view.get(self.cur).map(|&i| self.snap.tabs[i].id)
    }

    fn pos(&self, id: i64) -> Option<usize> {
        self.view.iter().position(|&i| self.snap.tabs[i].id == id)
    }

    /// The tabs at these places in `view`.
    fn ids(&self, ks: impl IntoIterator<Item = usize>) -> Vec<i64> {
        ks.into_iter().filter(|&k| k < self.view.len()).map(|k| self.tab(k).id).collect()
    }

    fn open_count(&self) -> usize {
        self.snap.tabs.iter().filter(|t| !self.closed.contains(&t.id)).count()
    }

    fn visual_range(&self) -> Option<RangeInclusive<usize>> {
        let anchor = self.visual?;
        if self.view.is_empty() {
            return None;
        }
        let a = self.pos(anchor).unwrap_or(self.cur);
        Some(a.min(self.cur)..=a.max(self.cur))
    }

    fn flash(&mut self, m: impl Into<String>) {
        self.msg = Some((m.into(), Instant::now()));
    }

    /// Recompute what's shown (filter, order, duplicates), keeping the cursor
    /// on tab `keep` when it's still there and on the same row otherwise.
    fn set_view(&mut self, keep: Option<i64>) {
        let tabs = &self.snap.tabs;
        self.dups.clear();
        for t in tabs.iter().filter(|t| !self.closed.contains(&t.id)) {
            *self.dups.entry(t.dup_key().to_string()).or_default() += 1;
        }
        let words: Vec<String> = self.query.split_whitespace().map(str::to_lowercase).collect();
        let mut view: Vec<usize> = (0..tabs.len()).filter(|&i| !self.closed.contains(&tabs[i].id) && matches(&tabs[i], &words)).collect();
        match self.order {
            Order::Strip => {}
            Order::Site => {
                let mut n: HashMap<String, usize> = HashMap::new();
                for &i in &view {
                    *n.entry(tabs[i].host()).or_default() += 1;
                }
                // Stable: within a site, tab-strip order.
                view.sort_by_cached_key(|&i| {
                    let h = tabs[i].host();
                    (Reverse(n[&h]), h)
                });
            }
            Order::Age => view.sort_by(|&a, &b| tabs[a].last.total_cmp(&tabs[b].last)),
        }
        self.view = view;
        let at = keep.and_then(|id| self.pos(id));
        self.cur = at.unwrap_or(self.cur).min(self.view.len().saturating_sub(1));
    }

    /// Re-read every tab; the cursor goes to `focus` when given, else stays on its tab.
    fn refresh(&mut self, focus: Option<i64>) {
        self.fetched = Instant::now();
        match bridge::list(&self.host) {
            Ok(s) => {
                let keep = focus.or_else(|| self.selected_id());
                self.snap = s;
                let live: HashSet<i64> = self.snap.tabs.iter().map(|t| t.id).collect();
                self.closed.retain(|id| live.contains(id));
                self.marks.retain(|id| live.contains(id));
                if self.visual.is_some_and(|id| !live.contains(&id)) {
                    self.visual = None;
                }
                self.set_view(keep);
            }
            Err(e) => self.flash(e),
        }
    }

    /// Closes and reopens that finished, the flash running out, the list going stale.
    fn tick(&mut self) -> bool {
        let mut dirty = false;
        while let Ok(done) = self.done_rx.try_recv() {
            match done {
                Done::Closed(gone, Ok(())) => {
                    let m = match gone.as_slice() {
                        [one] => format!("closed {} · u reopens", one.title),
                        many => format!("closed {} tabs · u reopens", many.len()),
                    };
                    self.flash(m);
                    self.undo.push(gone);
                    if self.undo.len() > UNDO_DEPTH {
                        self.undo.remove(0);
                    }
                }
                Done::Closed(gone, Err(e)) => {
                    // Show them again: they're still open.
                    for g in &gone {
                        self.closed.remove(&g.id);
                    }
                    let keep = self.selected_id();
                    self.set_view(keep);
                    self.flash(format!("couldn't close: {e}"));
                }
                Done::Reopened(gone, Ok((ids, failed))) => {
                    self.refresh(ids.first().copied());
                    let mut m = match (ids.len(), gone.as_slice()) {
                        (1, [one]) => format!("reopened {}", one.title),
                        (n, _) => format!("reopened {n} tab{}", if n == 1 { "" } else { "s" }),
                    };
                    if failed > 0 {
                        m.push_str(&format!(" · {failed} wouldn't open"));
                    }
                    self.flash(m);
                }
                Done::Reopened(gone, Err(e)) => {
                    self.undo.push(gone);
                    self.flash(format!("couldn't reopen: {e}"));
                }
            }
            dirty = true;
        }
        if self.msg.as_ref().is_some_and(|(_, at)| at.elapsed() > FLASH) {
            self.msg = None;
            dirty = true;
        }
        if self.live && self.fetched.elapsed() > REFRESH {
            self.refresh(None);
            dirty = true;
        }
        dirty
    }

    fn key(&mut self, k: KeyEvent) -> bool {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && k.code == KeyCode::Char('c') {
            return true;
        }
        if self.help {
            // Any key puts the list back.
            self.help = false;
            return false;
        }
        if self.typing {
            self.filter_key(k, ctrl);
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
            // Esc drops a half-typed count before anything else.
            KeyCode::Esc if count.is_some() => {}
            KeyCode::Esc => return self.escape(),
            KeyCode::Char('q') => return true,
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
            KeyCode::Char(';' | 'x') => self.close(n),
            KeyCode::Char(' ' | 'm') => self.mark(n),
            KeyCode::Char('v') => self.visual = if self.visual.is_some() { None } else { self.selected_id() },
            KeyCode::Char('*') => self.mark_site(),
            KeyCode::Char('D') => self.mark_dups(),
            KeyCode::Char('a') => self.mark_all(),
            KeyCode::Char('u') => self.reopen(),
            KeyCode::Char('/') => {
                self.typing = true;
                self.visual = None;
            }
            KeyCode::Char('s') => {
                self.order = self.order.next();
                let keep = self.selected_id();
                self.set_view(keep);
            }
            KeyCode::Char('?') => self.help = true,
            _ => {}
        }
        false
    }

    /// Esc undoes the most recent kind of state, one at a time, then quits.
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
            let keep = self.selected_id();
            self.set_view(keep);
            return false;
        }
        true
    }

    /// Typing into `/`: the list narrows as you type and the cursor goes to the
    /// first match; ↑↓ (^p ^n) move, ⏎ keeps the filter, esc drops it.
    fn filter_key(&mut self, k: KeyEvent, ctrl: bool) {
        match k.code {
            KeyCode::Esc => {
                self.typing = false;
                self.query.clear();
                let keep = self.selected_id();
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

    /// Mark them all, or unmark them all when they already are. True when it marked.
    fn toggle_marks(&mut self, ids: &[i64]) -> bool {
        if !ids.is_empty() && ids.iter().all(|id| self.marks.contains(id)) {
            for id in ids {
                self.marks.remove(id);
            }
            false
        } else {
            self.marks.extend(ids.iter().copied());
            true
        }
    }

    /// Space: flip the mark on `n` tabs from the cursor down and move past them.
    /// In visual mode, mark the range instead.
    fn mark(&mut self, n: usize) {
        if let Some(r) = self.visual_range() {
            self.visual = None;
            let ids = self.ids(r);
            self.toggle_marks(&ids);
            return;
        }
        for id in self.ids(self.cur..self.cur + n) {
            if !self.marks.remove(&id) {
                self.marks.insert(id);
            }
        }
        self.move_by(n as isize);
    }

    /// `*`: every shown tab on the cursor tab's site.
    fn mark_site(&mut self) {
        let Some(site) = self.view.get(self.cur).map(|&i| self.snap.tabs[i].host()) else { return };
        let ids: Vec<i64> = self.view.iter().map(|&i| &self.snap.tabs[i]).filter(|t| t.host() == site).map(|t| t.id).collect();
        let n = ids.len();
        if self.toggle_marks(&ids) {
            self.flash(format!("marked {n} on {site} · ; closes"));
        } else {
            self.flash(format!("unmarked {site}"));
        }
    }

    /// `D`: every shown tab whose URL another shown tab also has, except the
    /// copy you used last.
    fn mark_dups(&mut self) {
        let mut by_url: HashMap<&str, Vec<&Tab>> = HashMap::new();
        for &i in &self.view {
            let t = &self.snap.tabs[i];
            by_url.entry(t.dup_key()).or_default().push(t);
        }
        let mut ids = Vec::new();
        for copies in by_url.values().filter(|c| c.len() > 1) {
            let keep = copies.iter().max_by(|a, b| a.last.total_cmp(&b.last)).map(|t| t.id);
            ids.extend(copies.iter().map(|t| t.id).filter(|&id| Some(id) != keep));
        }
        if ids.is_empty() {
            self.flash("no duplicates");
            return;
        }
        let n = ids.len();
        if self.toggle_marks(&ids) {
            self.flash(format!("marked {n} duplicate{} (kept the copy used last) · ; closes", if n == 1 { "" } else { "s" }));
        } else {
            self.flash("unmarked the duplicates");
        }
    }

    /// `a`: everything shown, which after a `/` filter is every match.
    fn mark_all(&mut self) {
        let ids = self.ids(0..self.view.len());
        let n = ids.len();
        if self.toggle_marks(&ids) {
            self.flash(format!("marked all {n} · ; closes"));
        } else {
            self.flash("unmarked all");
        }
    }

    /// `;`: the visual range if there is one, else every marked tab, else `n`
    /// tabs from the cursor down. Now, no questions: `u` brings them back.
    fn close(&mut self, n: usize) {
        let ids = if let Some(r) = self.visual_range() {
            self.visual = None;
            self.ids(r)
        } else if !self.marks.is_empty() {
            // Shown or not: the header says how many are marked.
            self.snap.tabs.iter().filter(|t| self.marks.contains(&t.id) && !self.closed.contains(&t.id)).map(|t| t.id).collect()
        } else {
            self.ids(self.cur..self.cur + n)
        };
        self.close_ids(ids);
    }

    fn close_ids(&mut self, ids: Vec<i64>) {
        if ids.is_empty() {
            return;
        }
        if ids.len() >= self.open_count() {
            self.flash("that's every tab, and Chrome would quit: leave one open");
            return;
        }
        let doomed: HashSet<i64> = ids.iter().copied().collect();
        // The cursor stays on its tab if that survives; otherwise it goes to the
        // next tab down that does (the one above, at the end).
        let order = self.ids(0..self.view.len());
        let at = self.cur.min(order.len());
        let keep = order[at..].iter().chain(order[..at].iter().rev()).find(|id| !doomed.contains(id)).copied();
        let gone: Vec<Gone> = self.snap.tabs.iter().filter(|t| doomed.contains(&t.id)).map(Tab::gone).collect();
        for id in &ids {
            self.closed.insert(*id);
            self.marks.remove(id);
        }
        self.set_view(keep);
        if self.live {
            let host = self.host.clone();
            let tx = self.done_tx.clone();
            std::thread::spawn(move || {
                let res = host.close(&ids);
                let _ = tx.send(Done::Closed(gone, res));
            });
        }
    }

    /// `u`: open the last batch of closed tabs again, where they were.
    fn reopen(&mut self) {
        let Some(gone) = self.undo.pop() else {
            self.flash("nothing to reopen");
            return;
        };
        if !self.live {
            return;
        }
        let host = self.host.clone();
        let tx = self.done_tx.clone();
        std::thread::spawn(move || {
            let res = host.reopen(&gone);
            let _ = tx.send(Done::Reopened(gone, res));
        });
    }

    /// Headings between the tabs: windows and tab groups, sites, or how long ago.
    fn build_rows(&mut self) {
        self.rows.clear();
        let tabs = &self.snap.tabs;
        match self.order {
            Order::Strip => {
                let many_windows = self.snap.windows.len() > 1;
                let mut prev: Option<(i64, i64)> = None;
                for (k, &i) in self.view.iter().enumerate() {
                    let t = &tabs[i];
                    let new_window = prev.is_none_or(|(w, _)| w != t.window);
                    if many_windows && new_window {
                        let n = self.snap.windows.iter().position(|w| w.id == t.window).map_or(0, |p| p + 1);
                        let mut s = format!("window {n}");
                        if let Some(w) = self.snap.windows.iter().find(|w| w.id == t.window) {
                            if w.incognito {
                                s.push_str(" · incognito");
                            }
                            if w.focused {
                                s.push_str(" · in front");
                            }
                        }
                        self.rows.push(Row::Header(s, self.pal.muted));
                    }
                    if t.group != -1 && (new_window || prev.is_none_or(|(_, g)| g != t.group)) {
                        let g = self.snap.groups.get(&t.group);
                        let title = g.map(|g| g.title.clone()).filter(|s| !s.is_empty()).unwrap_or_else(|| "group".to_string());
                        let color = g.map_or(self.pal.muted, |g| self.pal.group(&g.color));
                        self.rows.push(Row::Header(title, color));
                    }
                    prev = Some((t.window, t.group));
                    self.rows.push(Row::Tab(k));
                }
            }
            Order::Site => {
                let mut n: HashMap<String, usize> = HashMap::new();
                for &i in &self.view {
                    *n.entry(tabs[i].host()).or_default() += 1;
                }
                let mut prev: Option<String> = None;
                for (k, &i) in self.view.iter().enumerate() {
                    let site = tabs[i].host();
                    if prev.as_deref() != Some(site.as_str()) {
                        self.rows.push(Row::Header(format!("{site} · {}", n[&site]), self.pal.muted));
                        prev = Some(site);
                    }
                    self.rows.push(Row::Tab(k));
                }
            }
            Order::Age => {
                const NAMES: [&str; 4] = ["used over a week ago", "used over a day ago", "used over an hour ago", "used in the last hour"];
                let now = now_ms();
                let bucket = |last: f64| {
                    let s = (now - last) / 1000.0;
                    if last <= 0.0 || s >= 7.0 * 86400.0 {
                        0
                    } else if s >= 86400.0 {
                        1
                    } else if s >= 3600.0 {
                        2
                    } else {
                        3
                    }
                };
                let mut n = [0usize; 4];
                for &i in &self.view {
                    n[bucket(tabs[i].last)] += 1;
                }
                let mut prev = None;
                for (k, &i) in self.view.iter().enumerate() {
                    let b = bucket(tabs[i].last);
                    if prev != Some(b) {
                        self.rows.push(Row::Header(format!("{} · {}", NAMES[b], n[b]), self.pal.muted));
                        prev = Some(b);
                    }
                    self.rows.push(Row::Tab(k));
                }
            }
        }
    }

    /// The box, centered, and the list scrolled so the cursor shows.
    fn layout(&mut self, area: Rect) -> Rect {
        self.build_rows();
        self.tall = self.tall.max(self.rows.len()).max(1);
        if self.help {
            self.tall = self.tall.max(help_lines().count());
        }
        // A line clear above and below the box when there's room.
        let room = area.height.saturating_sub(2).max(area.height.min(3)) as usize;
        self.list_h = self.tall.min(room.saturating_sub(2)).max(1);
        let w = area.width.saturating_sub(4).min(MAX_W).max(area.width.min(24));
        let h = (self.list_h as u16 + 2).min(area.height);
        let r = Rect::new(area.x + (area.width - w) / 2, area.y + (area.height - h) / 2, w, h);

        let row = self.rows.iter().position(|r| matches!(r, Row::Tab(k) if *k == self.cur)).unwrap_or(0);
        // Keep the headings above the cursor's tab in view with it.
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
        r
    }
}

/// Every word in the title or the URL, ignoring case.
fn matches(t: &Tab, words: &[String]) -> bool {
    if words.is_empty() {
        return true;
    }
    let (title, url) = (t.title.to_lowercase(), t.url.to_lowercase());
    words.iter().all(|w| title.contains(w.as_str()) || url.contains(w.as_str()))
}

/// The key list `?` shows: HELP from `move:` up to `options:`.
fn help_lines() -> impl Iterator<Item = &'static str> {
    HELP.lines().skip_while(|l| !l.starts_with("move:")).take_while(|l| !l.starts_with("options:"))
}

// ---- drawing -----------------------------------------------------------------

fn draw(app: &mut App, area: Rect, buf: &mut Buffer) {
    let r = app.layout(area);
    let p = &app.pal;
    Clear.render(r, buf);
    let open = app.open_count();
    let vis = app.visual_range();

    // Top border: the browser, the count, duplicates, the order; marks in red.
    let dupes: usize = app.dups.values().map(|n| n - 1).sum();
    let mut head = format!(" {} · {open} tabs", app.host.browser);
    if dupes > 0 {
        head.push_str(&format!(" · {dupes} duplicate{}", if dupes == 1 { "" } else { "s" }));
    }
    if app.order != Order::Strip {
        head.push_str(" · ");
        head.push_str(app.order.name());
    }
    head.push(' ');
    let marked = if app.marks.is_empty() { String::new() } else { format!(" {} marked ", app.marks.len()) };
    let room = (r.width as usize).saturating_sub(4 + marked.width());
    let title = Line::from(vec![
        Span::styled(truncate(&head, room), fg(p.muted)),
        Span::styled(marked, fg(p.red).add_modifier(Modifier::BOLD)),
    ]);

    // Bottom border: the filter being typed, a message, or what the keys do now.
    let room = r.width.saturating_sub(6) as usize;
    // As many as fit, left to right.
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
        hints(&[("any key", "back to the tabs")])
    } else if app.typing {
        Line::from(vec![
            Span::styled(" /", fg(p.accent)),
            Span::styled(app.query.clone(), fg(p.bright)),
            Span::styled("▏", fg(p.accent)),
            Span::styled(format!(" {} of {open} ", app.view.len()), fg(p.dim)),
        ])
    } else if let Some((m, _)) = &app.msg {
        Line::from(Span::styled(format!(" {} ", truncate(m, room)), fg(p.yellow)))
    } else if let Some(c) = app.count {
        Line::from(Span::styled(format!(" {c} "), fg(p.yellow)))
    } else if let Some(v) = &vis {
        let n = v.end() - v.start() + 1;
        hints(&[("visual", &format!("{n}")), (";", "close them"), ("space", "mark them"), ("esc", "cancel")])
    } else if !app.marks.is_empty() {
        let n = app.marks.len();
        hints(&[(";", &format!("close {n}")), ("u", "undo"), ("esc", "unmark")])
    } else if !app.query.is_empty() {
        let shown = format!("{} of {open}", app.view.len());
        let mut l = hints(&[("a", "mark all"), (";", "close"), ("esc", "drop filter")]);
        l.spans.insert(0, Span::styled(format!(" /{} · {shown}", truncate(&app.query, 30)), fg(p.accent)));
        l
    } else {
        hints(&[("space", "mark"), (";", "close"), ("u", "undo"), ("/", "filter"), ("s", "sort"), ("?", "keys")])
    };

    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(fg(p.border))
        .style(Style::new().bg(p.panel))
        .title(title)
        .title_bottom(foot);
    let inner = block.inner(r);
    block.render(r, buf);

    let max = inner.right().saturating_sub(1);
    if app.help {
        // HELP's key lines are the keys in columns 2..23, then what they do.
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
        let none = if app.query.is_empty() { "no tabs left".to_string() } else { format!("nothing matches “{}”", app.query) };
        put(buf, inner.x + 2, inner.y, max, &none, fg(p.dim));
        return;
    }
    let nw = app.view.len().to_string().len();
    let now = now_ms();
    for (i, row) in app.rows.iter().enumerate().skip(app.top).take(inner.height as usize) {
        let y = inner.y + (i - app.top) as u16;
        match row {
            Row::Header(text, color) => {
                put(buf, inner.x + 1, y, max, &truncate(text, max.saturating_sub(inner.x + 1) as usize), fg(*color).add_modifier(Modifier::BOLD));
            }
            Row::Tab(k) => tab_row(app, buf, inner, y, *k, nw, vis.as_ref(), now),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn tab_row(app: &App, buf: &mut Buffer, inner: Rect, y: u16, k: usize, nw: usize, vis: Option<&RangeInclusive<usize>>, now: f64) {
    let p = &app.pal;
    let t = app.tab(k);
    let max = inner.right().saturating_sub(1);
    let on = k == app.cur;
    // Marked, or in the visual range: the next `;` closes it.
    let doomed = app.marks.contains(&t.id) || vis.is_some_and(|r| r.contains(&k));
    if on {
        buf.set_style(Rect::new(inner.x, y, inner.width, 1), Style::new().bg(p.sel));
    } else if doomed {
        buf.set_style(Rect::new(inner.x, y, inner.width, 1), Style::new().bg(p.doomed));
    }
    // A stripe in the group's color down the edge of a group's tabs.
    if let Some(g) = app.snap.groups.get(&t.group) {
        put(buf, inner.x, y, max, "▎", fg(p.group(&g.color)));
    }
    // Relative numbers, as in jv: the cursor row its own number, the rest
    // their distance (5j gets there, 5x closes that many).
    let (n, nst) = if on { (k + 1, fg(p.yellow).add_modifier(Modifier::BOLD)) } else { (k.abs_diff(app.cur), fg(p.dim)) };
    let x = put(buf, inner.x + 1, y, max, &format!("{n:>nw$}"), nst) + 1;
    let (dot, dc) = if doomed {
        ("✕", p.red)
    } else if t.loading {
        ("●", p.yellow)
    } else if t.audible && !t.muted {
        ("♪", p.yellow)
    } else if t.discarded {
        ("○", p.dim)
    } else if t.active {
        ("●", p.green)
    } else {
        ("●", p.dim)
    };
    let x = put(buf, x, y, max, dot, fg(dc)) + 1;

    let title_st = match (doomed, on) {
        (true, true) => fg(p.red).add_modifier(Modifier::BOLD),
        (true, false) => fg(p.red),
        (false, true) => fg(p.bright).add_modifier(Modifier::BOLD),
        (false, false) => fg(p.fg),
    };
    let dup = app.dups.get(t.dup_key()).is_some_and(|&n| n > 1);
    let url_st = fg(if dup { p.yellow } else if on { p.muted } else { p.dim });

    // Title | URL | age, in fixed columns so the URLs line up.
    let avail = max.saturating_sub(x) as usize;
    let age = if avail >= 40 { age_label(t.last, now) } else { String::new() };
    let rest = if avail >= 40 { avail - 6 } else { avail };
    if rest >= 48 {
        let title_w = rest * 11 / 20;
        let url_w = rest - title_w - 2;
        put(buf, x, y, max, &truncate(t.display_title(), title_w), title_st);
        put(buf, x + (title_w + 2) as u16, y, max, &truncate(t.short_url(), url_w), url_st);
    } else {
        // Narrow: the title, and the site on the right when there's room.
        let host = truncate_left(&t.host(), (rest / 3).clamp(8, 24));
        let show_host = rest >= host.width() + 2 + 14;
        let title_w = if show_host { rest - host.width() - 2 } else { rest };
        put(buf, x, y, max, &truncate(t.display_title(), title_w), title_st);
        if show_host {
            put(buf, x + (rest - host.width()) as u16, y, max, &host, url_st);
        }
    }
    if !age.is_empty() {
        put(buf, max - age.width() as u16, y, max, &age, fg(if on { p.muted } else { p.dim }));
    }
}
