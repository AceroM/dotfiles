//! State and input handling. Drawing lives in ui.rs and only reads from here.

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use ratatui::crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::Rect;
use ratatui::style::Style;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::agent::{self, Field};
use crate::ansi;
use crate::herdr;
use crate::transcript::{self, Transcript};
use crate::diff::{self, FileDiff, Kind, Status};
use crate::doc::{self, Doc, Geo, Note, Row};
use crate::fuzzy;
use crate::highlight::{FileHl, Hl};
use crate::source::{self, PrMeta, Source};
use crate::theme::Palette;
use crate::tree::{self, RowKind};
use crate::viewed::Viewed;

/// Files with more changed lines than this start folded, like GitHub's
/// "Large diffs are not rendered by default".
pub const LARGE: usize = 1500;
/// Diff panes at least this wide start in split view.
const SPLIT_MIN: u16 = 150;
/// Clicks this close together on one cell count as a double / triple click.
const MULTI_CLICK: Duration = Duration::from_millis(450);
/// A drag held past the top or bottom of the diff scrolls a row this often.
const AUTOSCROLL: Duration = Duration::from_millis(40);
/// The `;` dialog re-reads the tabs and the preview this often.
const TABS_REFRESH: Duration = Duration::from_millis(700);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Tree,
    Diff,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Normal,
    Search,
    /// Typing the tree filter (`/` with the tree focused).
    Filter,
    GoTo,
    Help,
    /// The `c` box: a prompt for an agent in a new Herdr tab.
    Ask,
    /// The `;` dialog: this Herdr space's other tabs.
    Tabs,
}

pub enum Act {
    None,
    Quit,
    /// Leave the alternate screen and run this command (a terminal editor).
    Suspend(Vec<String>),
}

#[derive(Default, Clone, Copy)]
pub struct Lay {
    pub top: Rect,
    pub tree: Rect,
    pub sep: Rect,
    pub diff: Rect,
    pub status: Rect,
}

pub struct Match {
    pub f: usize,
    pub h: usize,
    pub l: usize,
    pub range: Range<usize>,
}

pub struct Search {
    pub query: String,
    pub matches: Vec<Match>,
    pub cur: usize,
    by_line: HashMap<(usize, usize, usize), Vec<usize>>,
}

/// A cell of the diff pane: a doc row, and a column from the pane's left edge.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Pos {
    pub row: usize,
    pub col: u16,
}

/// Text picked with the mouse. Only code is selectable: line numbers, signs
/// and headers stay out of the copy, and split view copies only the side the
/// drag started on.
pub struct Sel {
    anchor: Pos,
    head: Pos,
    right: bool,
    /// Drawn and copied: the drag left its first cell, or a double/triple click.
    shown: bool,
}

/// The left button is down in the diff pane (screen cells).
struct Drag {
    from: (u16, u16),
    to: (u16, u16),
}

/// Where one code row's text sits in the diff pane.
struct CodeCell {
    f: usize,
    h: usize,
    l: usize,
    /// Pane column the code starts at, and how many columns it gets.
    x: u16,
    w: usize,
    /// Bytes of the line this row shows: one wrapped segment, or all of it.
    range: Range<usize>,
    /// Columns scrolled off the left (no-wrap).
    skip: usize,
}

#[derive(Clone, Copy)]
enum Anchor {
    File(usize),
    Hunk(usize, usize),
    Line(usize, usize, usize),
}

pub struct Opts {
    pub split: Option<bool>,
    pub wrap: bool,
    pub show_tests: bool,
}

pub struct App {
    pub source: Source,
    pub files: Vec<FileDiff>,
    pub meta: Option<PrMeta>,
    pub meta_rx: Option<mpsc::Receiver<PrMeta>>,
    hl: Hl,
    pub hl_cache: HashMap<usize, FileHl>,
    pub pal: Palette,
    pub show_tests: bool,
    /// Shown files, in tree order.
    pub visible: Vec<usize>,
    pub hidden_tests: usize,
    tree_nodes: Vec<tree::Node>,
    pub tree_rows: Vec<tree::Row>,
    collapsed_dirs: HashSet<String>,
    pub tree_cur: usize,
    pub tree_top: usize,
    tree_w: u16,
    /// Width set with `<` / `>`; overrides the automatic one.
    tree_fixed: Option<u16>,
    /// Digits in the tree's relative line numbers.
    pub tree_nw: usize,
    pub show_tree: bool,
    pub focus: Focus,
    pub mode: Mode,
    split_pref: Option<bool>,
    pub wrap: bool,
    pub doc: Doc,
    pub scroll: usize,
    pub hscroll: usize,
    fold: HashMap<usize, bool>,
    pub viewed: Viewed,
    pub search: Option<Search>,
    search_origin: usize,
    /// Tree filter: only files whose path holds every space-separated term
    /// are shown, in the tree and in the diff. Empty when off.
    pub filter: String,
    /// The filter as it was before `/`, put back by Esc.
    filter_origin: String,
    /// Files the tree would show without the filter.
    pub unfiltered: usize,
    /// Text being typed in the search prompt or go-to-file picker.
    pub input: String,
    pub goto: Vec<(usize, Vec<usize>)>,
    pub goto_cur: usize,
    pub msg: Option<(String, Instant)>,
    pub lay: Lay,
    repo_root: Option<PathBuf>,
    nw: usize,
    /// Vim count typed so far (`12` before `j`, `G`, …).
    pub count: Option<usize>,
    /// Where `^o` goes back to: positions before g/G/go-to/search jumps.
    jumps: Vec<Anchor>,
    /// Line picked with `{n}G`, marked in the gutter until the next key.
    pub mark: Option<(usize, usize, usize)>,
    pub sel: Option<Sel>,
    drag: Option<Drag>,
    scrolled_at: Instant,
    /// Last click: when, where, and how many in a row (for 2× / 3× clicks).
    clicks: Option<(Instant, u16, u16, u8)>,
    /// Off for --snapshot, so a scripted run leaves the clipboard alone and
    /// starts no agent tabs.
    pub live: bool,
    /// The last text copied, whether or not it reached the clipboard.
    pub copied: Option<String>,
    /// The `c` box's draft, kept across Esc until it's sent.
    pub ask: Field,
    /// Files behind the draft's `[Image #N]` tags (N - 1 indexes this).
    ask_images: Vec<PathBuf>,
    /// What ^i puts in the box: the file being looked at when it opened.
    pub ask_path: Option<String>,
    /// The agent kind `c` starts (`$JV_AGENT`'s first word).
    pub ask_kind: String,
    /// Where the agent runs: the repo root, else where jv started.
    pub ask_cwd: PathBuf,
    bg_tx: mpsc::Sender<String>,
    bg_rx: mpsc::Receiver<String>,
    /// The `;` dialog, while it's open.
    pub tabs: Option<TabsView>,
    /// Tabs `x` closed: hidden even if Herdr still lists them for a moment.
    closed: HashSet<String>,
}

/// `;`: the other tabs in this Herdr space, and what the selected one shows.
pub struct TabsView {
    pub space: String,
    pub list: Vec<herdr::Tab>,
    pub cur: usize,
    /// The selected tab's focused pane: its latest lines, ending with its screen.
    pub preview: Vec<ansi::Line>,
    /// Rows the preview is scrolled up from the bottom (`u` / `d`).
    pub scroll: usize,
    /// A Claude tab scrolled past the top of its screen shows its transcript.
    pub transcript: Option<Transcript>,
    pub in_transcript: bool,
    fetched: Instant,
}

impl TabsView {
    pub fn selected(&self) -> Option<&herdr::Tab> {
        self.list.get(self.cur)
    }

    /// What the preview shows: the pane's lines, or the transcript's.
    pub fn lines(&self) -> &[ansi::Line] {
        match &self.transcript {
            Some(t) if self.in_transcript => &t.lines,
            _ => &self.preview,
        }
    }

    /// The preview lines shown in `h` rows: bottom-aligned, less the scroll.
    /// Trailing blank lines don't count as content.
    pub fn window(&self, h: usize) -> Range<usize> {
        let blank = |l: &ansi::Line| l.iter().all(|(s, _)| s.trim().is_empty());
        let end = self.lines().iter().rposition(|l| !blank(l)).map_or(0, |i| i + 1);
        let e = end - self.scroll.min(end.saturating_sub(h));
        e.saturating_sub(h)..e
    }

    /// How far up the preview can scroll in `h` rows.
    fn max_scroll(&self, h: usize) -> usize {
        let w = self.window(usize::MAX);
        (w.end - w.start).saturating_sub(h)
    }
}

fn digits(n: u32) -> usize {
    n.max(1).ilog10() as usize + 1
}

impl App {
    pub fn new(source: Source, text: &str, hl: Hl, pal: Palette, opts: Opts, viewed: Viewed) -> App {
        let parsed = diff::parse(text);
        let repo_root = source::repo_root();
        let ask_cwd = repo_root.clone().or_else(|| std::env::current_dir().ok()).unwrap_or_else(|| ".".into());
        let (bg_tx, bg_rx) = mpsc::channel();
        let mut app = App {
            source,
            files: parsed.files,
            meta: None,
            meta_rx: None,
            hl,
            hl_cache: HashMap::new(),
            pal,
            show_tests: opts.show_tests,
            visible: Vec::new(),
            hidden_tests: 0,
            tree_nodes: Vec::new(),
            tree_rows: Vec::new(),
            collapsed_dirs: HashSet::new(),
            tree_cur: 0,
            tree_top: 0,
            tree_w: 30,
            tree_fixed: None,
            tree_nw: 2,
            show_tree: true,
            focus: Focus::Tree,
            mode: Mode::Normal,
            split_pref: opts.split,
            wrap: opts.wrap,
            doc: Doc::empty(),
            scroll: 0,
            hscroll: 0,
            fold: HashMap::new(),
            viewed,
            search: None,
            search_origin: 0,
            filter: String::new(),
            filter_origin: String::new(),
            unfiltered: 0,
            input: String::new(),
            goto: Vec::new(),
            goto_cur: 0,
            msg: None,
            lay: Lay::default(),
            repo_root,
            nw: 3,
            count: None,
            jumps: Vec::new(),
            mark: None,
            sel: None,
            drag: None,
            scrolled_at: Instant::now(),
            clicks: None,
            live: true,
            copied: None,
            ask: Field::default(),
            ask_images: Vec::new(),
            ask_path: None,
            ask_kind: agent::spec().0,
            ask_cwd,
            bg_tx,
            bg_rx,
            tabs: None,
            closed: HashSet::new(),
        };
        app.rebuild_tree();
        app.rebuild_doc();
        app.sync_tree();
        app
    }

    // ---- derived state -------------------------------------------------

    pub fn is_collapsed(&self, f: usize) -> bool {
        let file = &self.files[f];
        let default = self.viewed.has(file.hash) || file.generated || file.line_count() > LARGE;
        self.fold.get(&f).copied().unwrap_or(default)
    }

    fn note_for(&self, f: usize) -> Option<Note> {
        if !self.is_collapsed(f) {
            return None;
        }
        let file = &self.files[f];
        Some(if self.viewed.has(file.hash) {
            Note::Viewed
        } else if file.generated || file.line_count() > LARGE {
            Note::Large
        } else {
            Note::Collapsed
        })
    }

    /// The file whose rows are at the top of the diff pane.
    pub fn cur_file(&self) -> Option<usize> {
        let rows = &self.doc.rows;
        rows.get(self.scroll..)
            .and_then(|s| s.iter().find_map(|r| r.file()))
            .or_else(|| rows[..self.scroll.min(rows.len())].iter().rev().find_map(|r| r.file()))
    }

    /// File whose header should pin to the top row (its own header scrolled off).
    pub fn sticky(&self) -> Option<usize> {
        match self.doc.rows.get(self.scroll)? {
            Row::File { .. } | Row::Blank => None,
            r => r.file(),
        }
    }

    pub fn max_scroll(&self) -> usize {
        let n = self.doc.rows.len();
        let h = self.lay.diff.height as usize;
        // Allow scrolling far enough that the last file's header reaches the top.
        let last = self
            .visible
            .last()
            .and_then(|&f| self.doc.file_row.get(f).copied())
            .filter(|&r| r != usize::MAX)
            .unwrap_or(0);
        n.saturating_sub(h).max(last)
    }

    pub fn percent(&self) -> usize {
        (self.scroll * 100).checked_div(self.max_scroll()).unwrap_or(100)
    }

    pub fn totals(&self) -> (usize, usize, usize) {
        let (a, d) = self.visible.iter().fold((0, 0), |(a, d), &f| (a + self.files[f].adds, d + self.files[f].dels));
        (self.visible.len(), a, d)
    }

    pub fn viewed_count(&self) -> usize {
        self.visible.iter().filter(|&&f| self.viewed.has(self.files[f].hash)).count()
    }

    pub fn search_ranges(&self, f: usize, h: usize, l: usize) -> Vec<(Range<usize>, bool)> {
        let Some(s) = &self.search else { return Vec::new() };
        s.by_line
            .get(&(f, h, l))
            .map(|ids| ids.iter().map(|&i| (s.matches[i].range.clone(), i == s.cur)).collect())
            .unwrap_or_default()
    }

    // ---- building ------------------------------------------------------

    pub fn filter_on(&self) -> bool {
        !self.filter.is_empty()
    }

    fn rebuild_tree(&mut self) {
        let base: Vec<usize> = (0..self.files.len()).filter(|&i| self.show_tests || !self.files[i].is_test).collect();
        let hit = |i: usize| tree::matches(&self.filter, &self.files[i].path);
        let shown: Vec<usize> = base.iter().copied().filter(|&i| hit(i)).collect();
        // Tests the filter matches but T hides; files the filter drops don't count.
        self.hidden_tests = (0..self.files.len()).filter(|&i| hit(i)).count() - shown.len();
        self.unfiltered = base.len();
        self.nw = digits(self.files.iter().map(|f| f.max_line_no).max().unwrap_or(0)).max(3);

        // Size the tree from the unfiltered files, so typing a filter doesn't
        // resize the panes (and re-wrap the diff) on every key.
        let full = tree::build(&self.files, &base);
        let mut all = Vec::new();
        tree::flatten(&full, &HashSet::new(), 0, &mut all);
        self.tree_nodes = if shown.len() == base.len() { full } else { tree::build(&self.files, &shown) };
        let mut order = Vec::new();
        tree::order(&self.tree_nodes, &mut order);
        self.visible = order;
        self.tree_nw = digits(all.len() as u32).max(2);
        let want = all
            .iter()
            .map(|r| {
                let name = match &r.kind {
                    RowKind::Dir { name, .. } => name.width() + 2,
                    RowKind::File { idx, name } => {
                        let f = &self.files[*idx];
                        name.width() + 2 + format!("+{} -{}", f.adds, f.dels).len() + 1
                    }
                };
                self.tree_nw + 1 + r.depth as usize * 2 + name + 3
            })
            .max()
            .unwrap_or(30);
        self.tree_w = (want as u16).clamp(30, 60);
        self.refresh_tree_rows();
    }

    fn refresh_tree_rows(&mut self) {
        let mut rows = Vec::new();
        tree::flatten(&self.tree_nodes, &self.collapsed_dirs, 0, &mut rows);
        self.tree_rows = rows;
        self.tree_cur = self.tree_cur.min(self.tree_rows.len().saturating_sub(1));
    }

    pub fn rebuild_doc(&mut self) {
        let anchor = self.anchor();
        let width = self.lay.diff.width;
        let geo = Geo { width, split: self.split_pref.unwrap_or(width >= SPLIT_MIN), wrap: self.wrap, nw: self.nw };
        let doc = doc::build(&self.files, &self.visible, |f| self.note_for(f), geo);
        self.doc = doc;
        // Rows moved, so a selection would now point at other text.
        self.sel = None;
        self.restore(anchor);
    }

    fn anchor(&self) -> Option<Anchor> {
        self.anchor_at(self.scroll)
    }

    fn anchor_at(&self, row: usize) -> Option<Anchor> {
        Some(match *self.doc.rows.get(row)? {
            Row::File { f } | Row::Note { f, .. } => Anchor::File(f as usize),
            Row::Hunk { f, h } => Anchor::Hunk(f as usize, h as usize),
            Row::Uni { f, h, l, .. } => Anchor::Line(f as usize, h as usize, l as usize),
            Row::Split { f, h, p, .. } => {
                let (lo, ro) = self.files[f as usize].hunks[h as usize].pairs[p as usize];
                Anchor::Line(f as usize, h as usize, lo.or(ro).unwrap_or(0))
            }
            Row::Blank => Anchor::File(self.cur_file()?),
        })
    }

    fn restore(&mut self, a: Option<Anchor>) {
        let Some(a) = a else {
            self.scroll = 0;
            return;
        };
        let f = match a {
            Anchor::File(f) | Anchor::Hunk(f, _) | Anchor::Line(f, _, _) => f,
        };
        let start = match self.doc.file_row.get(f) {
            Some(&r) if r != usize::MAX => r,
            _ => {
                self.scroll = 0;
                return;
            }
        };
        self.scroll = match a {
            Anchor::File(_) => start,
            Anchor::Hunk(_, h) => self.doc.rows[start..]
                .iter()
                .position(|r| matches!(*r, Row::Hunk { f: rf, h: rh } if rf as usize == f && rh as usize == h))
                .map_or(start, |i| start + i),
            Anchor::Line(_, h, l) => self.doc.line_row.get(&(f as u32, h as u32, l as u32)).copied().unwrap_or(start),
        };
        self.clamp_scroll();
    }

    pub fn layout_for(&mut self, area: Rect) {
        let (w, h) = (area.width, area.height);
        let main_h = h.saturating_sub(2);
        let top = Rect::new(0, 0, w, h.min(1));
        let status = Rect::new(0, h.saturating_sub(1), w, u16::from(h >= 2));
        let (tree, sep, diff) = if self.show_tree && w >= 70 {
            let tw = self.tree_fixed.unwrap_or(self.tree_w.min(w * 2 / 5)).clamp(16, w * 3 / 5);
            (Rect::new(0, 1, tw, main_h), Rect::new(tw, 1, 1, main_h), Rect::new(tw + 1, 1, w - tw - 1, main_h))
        } else {
            (Rect::default(), Rect::default(), Rect::new(0, 1, w, main_h))
        };
        let resized = diff.width != self.doc.geo.width;
        let taller = diff.height != self.lay.diff.height || tree.height != self.lay.tree.height;
        self.lay = Lay { top, tree, sep, diff, status };
        if resized {
            self.rebuild_doc();
        }
        if resized || taller {
            self.clamp_scroll();
            self.ensure_tree_visible();
        }
        self.clamp_tree_top();
    }

    /// Highlight the files that are on screen (cached per file).
    pub fn prepare(&mut self) {
        let h = self.lay.diff.height as usize + 1;
        let mut need = Vec::new();
        for r in self.doc.rows.iter().skip(self.scroll).take(h) {
            if matches!(r, Row::Uni { .. } | Row::Split { .. }) {
                if let Some(f) = r.file() {
                    if !need.contains(&f) && !self.hl_cache.contains_key(&f) {
                        need.push(f);
                    }
                }
            }
        }
        for f in need {
            let hl = self.hl.file(&self.files[f]);
            self.hl_cache.insert(f, hl);
        }
    }

    pub fn poll_meta(&mut self) -> bool {
        if let Some(rx) = &self.meta_rx {
            match rx.try_recv() {
                Ok(m) => {
                    self.meta = Some(m);
                    self.meta_rx = None;
                    return true;
                }
                Err(mpsc::TryRecvError::Disconnected) => self.meta_rx = None,
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        false
    }

    /// Status lines from background jobs (`c` agents, `;` closes), and the
    /// `;` dialog's live refresh. Returns true when a redraw is needed.
    pub fn poll_bg(&mut self) -> bool {
        let mut any = false;
        while let Ok(m) = self.bg_rx.try_recv() {
            self.flash(m);
            any = true;
        }
        if self.mode == Mode::Tabs && self.tabs.as_ref().is_some_and(|t| t.fetched.elapsed() > TABS_REFRESH) {
            self.refresh_tabs();
            any = true;
        }
        any
    }

    /// Expire the status-bar message. Returns true when a redraw is needed.
    pub fn tick(&mut self) -> bool {
        if self.msg.as_ref().is_some_and(|(_, t)| t.elapsed() > Duration::from_secs(3)) {
            self.msg = None;
            return true;
        }
        false
    }

    pub fn flash(&mut self, s: impl Into<String>) {
        self.msg = Some((s.into(), Instant::now()));
    }

    // ---- scrolling & navigation ------------------------------------------

    fn clamp_scroll(&mut self) {
        self.scroll = self.scroll.min(self.max_scroll());
    }

    fn scroll_by(&mut self, d: isize) {
        let max = self.max_scroll() as isize;
        self.scroll = (self.scroll as isize + d).clamp(0, max) as usize;
        self.sync_tree();
    }

    fn jump_file(&mut self, f: usize) {
        if let Some(&r) = self.doc.file_row.get(f) {
            if r != usize::MAX {
                self.scroll = r.min(self.max_scroll());
            }
        }
        self.sync_tree();
    }

    fn next_file(&mut self, dir: isize) {
        if self.visible.is_empty() {
            return;
        }
        let cur = self.cur_file().unwrap_or(self.visible[0]);
        let pos = self.visible.iter().position(|&x| x == cur).unwrap_or(0) as isize;
        let at_header = self.doc.file_row.get(cur) == Some(&self.scroll);
        // "previous" from the middle of a file goes to that file's top first.
        let target = if dir < 0 && !at_header { pos } else { pos + dir };
        let target = target.clamp(0, self.visible.len() as isize - 1) as usize;
        self.jump_file(self.visible[target]);
    }

    fn next_hunk(&mut self, dir: isize) {
        // A hunk header shows on row 1, under the sticky file header.
        let cur = self.scroll + 1;
        let rows = &self.doc.rows;
        let is_hunk = |r: &Row| matches!(r, Row::Hunk { .. });
        let found = if dir > 0 {
            rows.iter().enumerate().skip(cur + 1).find(|(_, r)| is_hunk(r)).map(|(i, _)| i)
        } else {
            rows[..cur.min(rows.len())].iter().rposition(is_hunk)
        };
        if let Some(r) = found {
            self.scroll = r.saturating_sub(1).min(self.max_scroll());
            self.sync_tree();
        }
    }

    // ---- jumps -------------------------------------------------------------

    /// Remember where we are so `^o` can come back after a jump.
    fn push_jump(&mut self) {
        self.push_jump_at(self.scroll);
    }

    fn push_jump_at(&mut self, row: usize) {
        if let Some(a) = self.anchor_at(row) {
            self.jumps.push(a);
            if self.jumps.len() > 100 {
                self.jumps.remove(0);
            }
        }
    }

    fn jump_back(&mut self) {
        match self.jumps.pop() {
            Some(a) => {
                self.restore(Some(a));
                self.sync_tree();
            }
            None => self.flash("no earlier jump"),
        }
    }

    fn tree_on(&self) -> bool {
        self.focus == Focus::Tree && self.lay.tree.width > 0
    }

    fn go_top(&mut self) {
        self.push_jump();
        self.scroll = 0;
        self.sync_tree();
        if self.tree_on() {
            self.tree_cur = 0;
            self.ensure_tree_visible();
        }
    }

    fn go_bottom(&mut self) {
        self.push_jump();
        self.scroll = self.max_scroll();
        self.sync_tree();
        if self.tree_on() {
            self.tree_cur = self.tree_rows.len().saturating_sub(1);
            self.ensure_tree_visible();
        }
    }

    /// `{n}G`: row n of the tree when it has focus, else line n of this file.
    fn goto_count(&mut self, n: usize) {
        if self.tree_on() {
            if self.tree_rows.is_empty() {
                return;
            }
            self.push_jump();
            let target = n.clamp(1, self.tree_rows.len()) - 1;
            self.tree_move(target as isize - self.tree_cur as isize);
        } else {
            self.goto_line(n as u32);
        }
    }

    /// Scroll to new-side line `n` of the current file (old side for a
    /// deleted file), or the nearest line the diff has.
    fn goto_line(&mut self, n: u32) {
        let Some(f) = self.cur_file() else { return };
        let file = &self.files[f];
        let deleted = file.status == Status::Deleted;
        let mut best: Option<(u32, usize, usize)> = None;
        for (hi, h) in file.hunks.iter().enumerate() {
            for (li, l) in h.lines.iter().enumerate() {
                let ln = match l.kind {
                    Kind::Del if !deleted => continue,
                    Kind::Del => l.old,
                    _ => l.new,
                };
                let d = ln.abs_diff(n);
                if best.is_none_or(|b| d < b.0) {
                    best = Some((d, hi, li));
                }
            }
        }
        let Some((d, h, l)) = best else {
            self.flash("no lines to go to in this file");
            return;
        };
        self.push_jump();
        if self.is_collapsed(f) {
            self.fold.insert(f, false);
            self.rebuild_doc();
        }
        let Some(&row) = self.doc.line_row.get(&(f as u32, h as u32, l as u32)) else { return };
        let top = self.doc.file_row.get(f).copied().unwrap_or(0);
        let hgt = self.lay.diff.height as usize;
        self.scroll = row.saturating_sub(hgt / 3).max(top).min(self.max_scroll());
        self.mark = Some((f, h, l));
        self.sync_tree();
        if d > 0 {
            let line = &self.files[f].hunks[h].lines[l];
            let got = if deleted { line.old } else { line.new };
            self.flash(format!("line {n} isn't in the diff · nearest is {got}"));
        }
    }

    fn sync_tree(&mut self) {
        let Some(f) = self.cur_file() else { return };
        let path = &self.files[f].path;
        let mut best = None;
        for (i, r) in self.tree_rows.iter().enumerate() {
            match &r.kind {
                RowKind::File { idx, .. } if *idx == f => {
                    best = Some(i);
                    break;
                }
                RowKind::Dir { path: p, open: false, .. }
                    if path.len() > p.len() && path.starts_with(p.as_str()) && path.as_bytes()[p.len()] == b'/' =>
                {
                    best = Some(i);
                }
                _ => {}
            }
        }
        if let Some(i) = best {
            self.tree_cur = i;
            self.ensure_tree_visible();
        }
    }

    fn ensure_tree_visible(&mut self) {
        let h = self.lay.tree.height as usize;
        if h == 0 {
            return;
        }
        let so = 2.min(h / 2);
        if self.tree_cur < self.tree_top + so {
            self.tree_top = self.tree_cur.saturating_sub(so);
        }
        if self.tree_cur + so >= self.tree_top + h {
            self.tree_top = self.tree_cur + so + 1 - h;
        }
        self.clamp_tree_top();
    }

    fn clamp_tree_top(&mut self) {
        let h = self.lay.tree.height as usize;
        self.tree_top = self.tree_top.min(self.tree_rows.len().saturating_sub(h));
    }

    fn tree_move(&mut self, d: isize) {
        if self.tree_rows.is_empty() {
            return;
        }
        self.tree_cur = (self.tree_cur as isize + d).clamp(0, self.tree_rows.len() as isize - 1) as usize;
        self.ensure_tree_visible();
        if let RowKind::File { idx, .. } = self.tree_rows[self.tree_cur].kind {
            self.jump_file(idx);
        }
    }

    /// Vim's ^d / ^u in the tree: scroll `pages` half-screens and carry the
    /// cursor the same distance, so it keeps its row on screen. At either end
    /// the view stops and the cursor goes the rest of the way.
    fn tree_half_page(&mut self, pages: isize) {
        let h = self.lay.tree.height as isize;
        let d = (h / 2).max(1) * pages;
        let max_top = self.tree_rows.len().saturating_sub(h as usize) as isize;
        self.tree_top = (self.tree_top as isize + d).clamp(0, max_top) as usize;
        self.tree_move(d);
    }

    fn tree_left(&mut self) {
        let Some(row) = self.tree_rows.get(self.tree_cur) else { return };
        match &row.kind {
            RowKind::Dir { path, open: true, .. } => {
                self.collapsed_dirs.insert(path.clone());
                self.refresh_tree_rows();
            }
            _ => {
                let depth = row.depth;
                if let Some(i) = (0..self.tree_cur).rev().find(|&i| self.tree_rows[i].depth < depth) {
                    self.tree_cur = i;
                }
            }
        }
        self.ensure_tree_visible();
    }

    /// `l` / Enter in the tree: open a folder, or move focus into the diff.
    fn tree_activate(&mut self, toggle: bool) {
        let Some(row) = self.tree_rows.get(self.tree_cur) else { return };
        match &row.kind {
            RowKind::Dir { path, open, .. } => {
                if *open && !toggle {
                    self.tree_move(1);
                    return;
                }
                if *open {
                    self.collapsed_dirs.insert(path.clone());
                } else {
                    self.collapsed_dirs.remove(path);
                }
                self.refresh_tree_rows();
                self.ensure_tree_visible();
            }
            RowKind::File { idx, .. } => {
                let idx = *idx;
                self.push_jump();
                self.jump_file(idx);
                self.focus = Focus::Diff;
            }
        }
    }

    // ---- actions ---------------------------------------------------------

    fn toggle_fold(&mut self, f: usize) {
        let now = self.is_collapsed(f);
        self.fold.insert(f, !now);
        self.rebuild_doc();
        self.jump_file(f);
    }

    /// `Z`: fold every file; again to go back to the defaults (viewed and
    /// large files stay folded), and once more to open those too.
    fn fold_all(&mut self) {
        let any_open = self.visible.iter().any(|&f| !self.is_collapsed(f));
        let msg = if any_open {
            for &f in &self.visible {
                self.fold.insert(f, true);
            }
            "folded every file · Z unfolds"
        } else {
            self.fold.clear();
            if self.visible.iter().all(|&f| self.is_collapsed(f)) {
                for &f in &self.visible {
                    self.fold.insert(f, false);
                }
                "unfolded every file"
            } else {
                "unfolded · viewed and large files stay folded (Z again opens them)"
            }
        };
        self.rebuild_doc();
        self.sync_tree();
        self.flash(msg);
    }

    /// On a folder in the tree: mark (or unmark) every file under it.
    fn toggle_viewed_dir(&mut self, dir: &str) {
        let prefix = format!("{dir}/");
        let files: Vec<usize> = self.visible.iter().copied().filter(|&f| self.files[f].path.starts_with(&prefix)).collect();
        let hashes: Vec<u64> = files.iter().map(|&f| self.files[f].hash).collect();
        let on = !hashes.iter().all(|&h| self.viewed.has(h));
        self.viewed.set_many(&hashes, on);
        for f in &files {
            self.fold.remove(f);
        }
        self.rebuild_doc();
        let n = files.len();
        let s = if n == 1 { "" } else { "s" };
        let name = dir.rsplit('/').next().unwrap_or(dir);
        self.flash(if on { format!("✓ viewed {n} file{s} in {name}/") } else { format!("unmarked {n} file{s} in {name}/") });
    }

    fn toggle_viewed(&mut self) {
        if self.tree_on() {
            if let Some(RowKind::Dir { path, .. }) = self.tree_rows.get(self.tree_cur).map(|r| &r.kind) {
                let dir = path.clone();
                self.toggle_viewed_dir(&dir);
                return;
            }
        }
        let Some(f) = self.cur_file() else { return };
        let h = self.files[f].hash;
        let on = !self.viewed.has(h);
        if on {
            self.push_jump();
        }
        self.viewed.set(h, on);
        self.fold.remove(&f);
        self.rebuild_doc();
        if on {
            let pos = self.visible.iter().position(|&x| x == f).unwrap_or(0);
            let next = self.visible[pos + 1..]
                .iter()
                .chain(self.visible[..pos].iter())
                .find(|&&x| !self.viewed.has(self.files[x].hash))
                .copied();
            self.jump_file(next.unwrap_or(f));
            let (n, v) = (self.visible.len(), self.viewed_count());
            self.flash(if v == n { format!("✓ all {n} files viewed") } else { format!("✓ viewed {v}/{n}") });
        } else {
            self.jump_file(f);
            self.flash("unmarked viewed");
        }
    }

    /// Rebuild after the set of shown files changes (T, the filter).
    fn refilter(&mut self) {
        self.rebuild_tree();
        self.rebuild_doc();
        if let Some(s) = self.search.take() {
            self.search = self.run_search(&s.query);
        }
        self.sync_tree();
    }

    fn toggle_tests(&mut self) {
        self.show_tests = !self.show_tests;
        self.refilter();
        let n = self.files.iter().filter(|f| f.is_test).count();
        self.flash(if self.show_tests { format!("showing {n} test files") } else { format!("hiding {n} test files") });
    }

    fn set_split(&mut self, split: bool) {
        self.split_pref = Some(split);
        self.rebuild_doc();
        self.flash(if split { "split view" } else { "unified view" });
    }

    fn first_code_line(&self) -> Option<(usize, u32)> {
        self.first_code_pos().map(|(f, n, _)| (f, n))
    }

    /// The top code line on screen: (file, line number, on the old side).
    fn first_code_pos(&self) -> Option<(usize, u32, bool)> {
        let h = self.lay.diff.height as usize;
        let start = self.scroll + usize::from(self.sticky().is_some());
        let num = |l: &diff::Line| if l.new > 0 { (l.new, false) } else { (l.old.max(1), true) };
        for r in self.doc.rows.iter().skip(start).take(h.max(1)) {
            let (f, line) = match *r {
                Row::Uni { f, h, l, .. } => (f, &self.files[f as usize].hunks[h as usize].lines[l as usize]),
                Row::Split { f, h, p, .. } => {
                    let hk = &self.files[f as usize].hunks[h as usize];
                    let (lo, ro) = hk.pairs[p as usize];
                    (f, &hk.lines[ro.or(lo)?])
                }
                _ => continue,
            };
            let (n, old) = num(line);
            return Some((f as usize, n, old));
        }
        self.cur_file().map(|f| (f, self.files[f].hunks.first().map_or(1, |h| h.new_start.max(1)), false))
    }

    /// `O`: this file, at the top line on screen, in the PR's diff on GitHub.
    fn open_github(&mut self) {
        let Some(url) = self.meta.as_ref().map(|m| m.url.clone()).filter(|u| !u.is_empty()) else {
            self.flash(if self.meta_rx.is_some() { "still loading the PR…" } else { "O needs a PR (jv <number>)" });
            return;
        };
        let Some((f, line, old)) = self.first_code_pos() else { return };
        let path = self.files[f].path.clone();
        let side = if old { 'L' } else { 'R' };
        let target = format!("{url}/files#diff-{}{side}{line}", source::sha256_hex(path.as_bytes()));
        let ok = source::open_url(&target);
        self.flash(if ok { format!("opened {path}:{line} on GitHub") } else { "couldn't open a browser".to_string() });
    }

    fn open_editor(&mut self) -> Act {
        let Some((f, line)) = self.first_code_line() else { return Act::None };
        let rel = self.files[f].path.clone();
        let abs = self.repo_root.clone().unwrap_or_else(|| PathBuf::from(".")).join(&rel);
        if !abs.exists() {
            self.flash(format!("{rel} isn't in this checkout"));
            return Act::None;
        }
        if source::which("zed") {
            let ok = Command::new("zed")
                .arg(format!("{}:{line}", abs.display()))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .is_ok();
            self.flash(if ok { format!("opened {rel}:{line} in Zed") } else { "couldn't start zed".to_string() });
            return Act::None;
        }
        let editor = std::env::var("VISUAL").or_else(|_| std::env::var("EDITOR")).unwrap_or_else(|_| "vi".into());
        let mut cmd: Vec<String> = editor.split_whitespace().map(String::from).collect();
        cmd.push(format!("+{line}"));
        cmd.push(abs.display().to_string());
        Act::Suspend(cmd)
    }

    fn clip(&mut self, text: &str) -> bool {
        self.copied = Some(text.to_string());
        !self.live || source::copy(text)
    }

    fn copy(&mut self, with_line: bool) {
        let Some((f, line)) = self.first_code_line() else { return };
        let path = &self.files[f].path;
        let text = if with_line { format!("{path}:{line}") } else { path.clone() };
        let ok = self.clip(&text);
        self.flash(if ok { format!("copied {text}") } else { "copy failed".to_string() });
    }

    /// `c`: open the agent box. ^i in it inserts the selection's file, else
    /// the file at the top of the diff.
    fn open_ask(&mut self, sel: Option<&Sel>) {
        if !agent::in_herdr() {
            self.flash(format!("c starts {} in a new Herdr tab · run jv inside Herdr", self.ask_kind));
            return;
        }
        let sel_file = sel.filter(|s| s.shown).and_then(|s| self.doc.rows.get(s.anchor.min(s.head).row)?.file());
        self.ask_path = sel_file.or_else(|| self.cur_file()).map(|f| self.files[f].path.clone());
        self.ask.end();
        self.mode = Mode::Ask;
    }

    fn send_ask(&mut self) {
        self.mode = Mode::Normal;
        let text = self.ask.text.trim();
        if text.is_empty() {
            return;
        }
        let prompt = agent::with_images(text, &self.ask_images);
        self.ask = Field::default();
        self.ask_images.clear();
        if self.live {
            agent::spawn(prompt, self.ask_cwd.clone(), self.bg_tx.clone());
        } else {
            self.copied = Some(prompt);
        }
        self.flash(format!("starting {} in a new tab…", self.ask_kind));
    }

    fn insert_ask_path(&mut self) {
        if let Some(p) = self.ask_path.clone() {
            self.ask.insert_word(&p);
        }
    }

    fn key_ask(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let alt = k.modifiers.contains(KeyModifiers::ALT);
        let f = &mut self.ask;
        match k.code {
            KeyCode::Esc => self.mode = Mode::Normal,
            KeyCode::Char('c') if ctrl => self.mode = Mode::Normal,
            // Newline: shift+Enter (the kitty keyboard protocol tells it from
            // Enter; see main.rs), alt+Enter, or ^j anywhere.
            KeyCode::Enter if alt || k.modifiers.contains(KeyModifiers::SHIFT) => f.insert("\n"),
            KeyCode::Char('j') if ctrl => f.insert("\n"),
            KeyCode::Enter => self.send_ask(),
            // ^i: the file's path. Without the kitty protocol ^i is a Tab, so Tab does it too.
            KeyCode::Char('i') if ctrl => self.insert_ask_path(),
            KeyCode::Tab => self.insert_ask_path(),
            KeyCode::Char('v') if ctrl => self.paste_image(),
            // Word jumps: alt/ctrl+←→ arrive as modified arrows, or as ESC b /
            // ESC f when the terminal sends option as meta.
            KeyCode::Left if alt || ctrl => f.word_left(),
            KeyCode::Right if alt || ctrl => f.word_right(),
            KeyCode::Char('b') if alt => f.word_left(),
            KeyCode::Char('f') if alt => f.word_right(),
            KeyCode::Char('d') if alt => f.kill_word_right(),
            KeyCode::Char('a') if ctrl => f.home(),
            KeyCode::Char('e') if ctrl => f.end(),
            KeyCode::Char('b') if ctrl => f.left(),
            KeyCode::Char('f') if ctrl => f.right(),
            KeyCode::Char('d') if ctrl => f.delete(),
            KeyCode::Char('u') if ctrl => f.kill_start(),
            KeyCode::Char('k') if ctrl => f.kill_end(),
            KeyCode::Char('w') if ctrl => f.kill_word(),
            KeyCode::Backspace if alt => f.kill_word(),
            KeyCode::Home => f.home(),
            KeyCode::End => f.end(),
            KeyCode::Left => f.left(),
            KeyCode::Right => f.right(),
            KeyCode::Backspace => f.backspace(),
            KeyCode::Delete => f.delete(),
            KeyCode::Char(c) if !ctrl => f.insert(c.encode_utf8(&mut [0; 4])),
            _ => {}
        }
    }

    fn attach(&mut self, path: PathBuf) {
        self.ask_images.push(path);
        let tag = format!("[Image #{}]", self.ask_images.len());
        self.ask.insert_word(&tag);
    }

    /// ^v in the agent box: the clipboard's image, as an `[Image #N]` tag.
    fn paste_image(&mut self) {
        match agent::clipboard_image() {
            Some(p) => self.attach(p),
            None => self.flash("no image on the clipboard"),
        }
    }

    /// Bracketed paste: whole into the agent box, first line into the others
    /// (as if typed, so search and the filter update). In the agent box, image
    /// files dropped in become tags, and an empty paste (⌘V with only an image
    /// on the clipboard) takes the clipboard's image.
    fn paste(&mut self, s: &str) {
        let s = s.replace("\r\n", "\n").replace('\r', "\n").replace('\t', "    ");
        match self.mode {
            Mode::Ask if s.trim().is_empty() => self.paste_image(),
            Mode::Ask => match agent::image_paths(&s) {
                Some(files) => files.into_iter().for_each(|f| self.attach(f)),
                None => self.ask.insert(&s),
            },
            Mode::Search | Mode::Filter | Mode::GoTo => {
                for c in s.lines().next().unwrap_or("").chars().filter(|c| !c.is_control()).take(500) {
                    self.key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
                }
            }
            _ => {}
        }
    }

    // ---- `;` tabs dialog ---------------------------------------------------

    fn open_tabs(&mut self) {
        if !agent::in_herdr() {
            self.flash("; lists this Herdr space's tabs · run jv inside Herdr");
            return;
        }
        self.closed.clear();
        self.tabs = Some(TabsView {
            space: String::new(),
            list: Vec::new(),
            cur: 0,
            preview: Vec::new(),
            scroll: 0,
            transcript: None,
            in_transcript: false,
            fetched: Instant::now(),
        });
        self.mode = Mode::Tabs;
        self.refresh_tabs();
    }

    fn close_tabs_view(&mut self) {
        self.mode = Mode::Normal;
        self.tabs = None;
    }

    /// Re-read the tabs (the cursor stays on its tab) and the preview.
    fn refresh_tabs(&mut self) {
        let ws = std::env::var("HERDR_WORKSPACE_ID").unwrap_or_default();
        let me = std::env::var("HERDR_TAB_ID").unwrap_or_default();
        let res = herdr::tabs(&ws, &me);
        let Some(v) = self.tabs.as_mut() else { return };
        v.fetched = Instant::now();
        match res {
            Ok((space, mut list)) => {
                list.retain(|t| !self.closed.contains(&t.id));
                let keep = v.selected().map(|t| t.id.clone());
                let at = keep.and_then(|id| list.iter().position(|t| t.id == id)).unwrap_or(v.cur);
                v.cur = at.min(list.len().saturating_sub(1));
                v.space = space;
                v.list = list;
            }
            // A hiccup while open keeps what's on screen; failing to open at all closes.
            Err(e) => {
                if v.list.is_empty() {
                    self.close_tabs_view();
                }
                self.flash(e);
                return;
            }
        }
        self.load_preview();
    }

    fn load_preview(&mut self) {
        let Some(v) = self.tabs.as_mut() else { return };
        v.preview = match v.selected().and_then(|t| t.pane.as_deref()) {
            Some(p) => herdr::read(p).map_or_else(|e| vec![vec![(e, Style::new())]], |t| ansi::parse(&t)),
            None => Vec::new(),
        };
    }

    fn tabs_move(&mut self, d: isize) {
        let Some(v) = self.tabs.as_mut() else { return };
        if v.list.is_empty() {
            return;
        }
        let n = (v.cur as isize).saturating_add(d).clamp(0, v.list.len() as isize - 1) as usize;
        if n != v.cur {
            v.cur = n;
            v.scroll = 0;
            self.load_preview();
        }
    }

    /// Rows inside the preview panel (the dialog spares the top bar and status line).
    fn preview_rows(&self) -> usize {
        (self.lay.status.y as usize).saturating_sub(3).max(1)
    }

    /// `u` / `d`: scroll the preview up (positive) or back down.
    fn preview_scroll(&mut self, d: isize) {
        let h = self.preview_rows();
        let Some(v) = self.tabs.as_mut() else { return };
        v.scroll = (v.scroll as isize).saturating_add(d).clamp(0, v.max_scroll(h) as isize) as usize;
    }

    /// `x`: close the selected tab now, no questions, like ctrl+alt+x.
    fn close_selected_tab(&mut self) {
        let Some(v) = self.tabs.as_mut() else { return };
        if v.cur >= v.list.len() {
            return;
        }
        let t = v.list.remove(v.cur);
        v.cur = v.cur.min(v.list.len().saturating_sub(1));
        self.closed.insert(t.id.clone());
        let name = if t.label.is_empty() { t.id.clone() } else { t.label.clone() };
        if self.live {
            let tx = self.bg_tx.clone();
            std::thread::spawn(move || {
                let msg = match herdr::close_tab(&t.id) {
                    Ok(()) => format!("closed {name}"),
                    Err(e) => format!("couldn't close {name}: {e}"),
                };
                let _ = tx.send(msg);
            });
        }
        self.load_preview();
    }

    /// Enter: switch Herdr to the selected tab.
    fn focus_selected_tab(&mut self) {
        let Some(id) = self.tabs.as_ref().and_then(|v| v.selected()).map(|t| t.id.clone()) else { return };
        if self.live {
            if let Err(e) = herdr::focus_tab(&id) {
                self.flash(e);
                return;
            }
        }
        self.close_tabs_view();
    }

    fn key_tabs(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let h = (self.lay.diff.height as isize / 2).max(1);
        let half = (self.preview_rows() as isize / 2).max(1);
        match k.code {
            KeyCode::Esc | KeyCode::Char('q') => self.close_tabs_view(),
            KeyCode::Char('c') if ctrl => self.close_tabs_view(),
            KeyCode::Char('d') if ctrl => self.tabs_move(h),
            KeyCode::Char('u') if ctrl => self.tabs_move(-h),
            // d / u: the preview, half a panel at a time (as in the diff).
            KeyCode::Char('d') => self.preview_scroll(-half),
            KeyCode::Char('u') => self.preview_scroll(half),
            KeyCode::Char('j') | KeyCode::Down => self.tabs_move(1),
            KeyCode::Char('k') | KeyCode::Up => self.tabs_move(-1),
            KeyCode::Char('g') | KeyCode::Home => self.tabs_move(isize::MIN),
            KeyCode::Char('G') | KeyCode::End => self.tabs_move(isize::MAX),
            // `;` again closes a tab too, so ;;; clears tabs from the home row.
            KeyCode::Char('x' | ';') => self.close_selected_tab(),
            KeyCode::Enter => self.focus_selected_tab(),
            _ => {}
        }
    }

    fn reload(&mut self) {
        if !self.source.reloadable() {
            self.flash("stdin can't be reloaded");
            return;
        }
        let keep = self.cur_file().map(|f| self.files[f].path.clone());
        match self.source.fetch() {
            Ok(text) => {
                self.files = diff::parse(&text).files;
                self.hl_cache.clear();
                self.fold.clear();
                self.search = None;
                self.doc = Doc::empty();
                self.scroll = 0;
                self.rebuild_tree();
                self.rebuild_doc();
                if let Some(f) = keep.and_then(|p| self.files.iter().position(|x| x.path == p)) {
                    self.jump_file(f);
                }
                self.flash(format!("reloaded · {} files", self.files.len()));
            }
            Err(e) => self.flash(format!("reload failed: {}", e.lines().next().unwrap_or(""))),
        }
    }

    // ---- search ----------------------------------------------------------

    fn run_search(&self, query: &str) -> Option<Search> {
        if query.is_empty() {
            return None;
        }
        let cs = query.chars().any(char::is_uppercase);
        let q = if cs { query.to_string() } else { query.to_ascii_lowercase() };
        let mut matches = Vec::new();
        let mut by_line: HashMap<(usize, usize, usize), Vec<usize>> = HashMap::new();
        'outer: for &f in &self.visible {
            for (hi, h) in self.files[f].hunks.iter().enumerate() {
                for (li, l) in h.lines.iter().enumerate() {
                    let lower;
                    let hay: &str = if cs {
                        &l.text
                    } else {
                        lower = l.text.to_ascii_lowercase();
                        &lower
                    };
                    let mut start = 0;
                    while let Some(pos) = hay[start..].find(&q) {
                        let s = start + pos;
                        by_line.entry((f, hi, li)).or_default().push(matches.len());
                        matches.push(Match { f, h: hi, l: li, range: s..s + q.len() });
                        start = s + q.len();
                        if matches.len() >= 20_000 {
                            break 'outer;
                        }
                    }
                }
            }
        }
        Some(Search { query: query.to_string(), matches, cur: 0, by_line })
    }

    fn code_w_for(&self, f: usize, kind: Kind) -> usize {
        let g = &self.doc.geo;
        let file = &self.files[f];
        if g.split && !file.one_sided() {
            g.side_code_w(kind != Kind::Del)
        } else {
            g.uni_code_w(file.one_sided())
        }
    }

    fn show_match(&mut self, i: usize) {
        let Some(m) = self.search.as_ref().and_then(|s| s.matches.get(i)) else { return };
        let (f, h, l, start) = (m.f, m.h, m.l, m.range.start);
        if self.is_collapsed(f) {
            self.fold.insert(f, false);
            self.rebuild_doc();
        }
        if let Some(s) = self.search.as_mut() {
            s.cur = i;
        }
        let Some(&row) = self.doc.line_row.get(&(f as u32, h as u32, l as u32)) else { return };
        let line = &self.files[f].hunks[h].lines[l];
        let w = self.code_w_for(f, line.kind);
        let seg = if self.wrap {
            doc::wrap_ranges(&line.text, w).iter().position(|r| r.contains(&start)).unwrap_or(0)
        } else {
            let col = line.text[..start].width();
            if col < self.hscroll || col + 4 > self.hscroll + w {
                self.hscroll = col.saturating_sub(8);
            }
            0
        };
        let target = row + seg;
        let hgt = self.lay.diff.height as usize;
        if target <= self.scroll || target >= self.scroll + hgt {
            self.scroll = target.saturating_sub(hgt / 3).min(self.max_scroll());
        }
        self.sync_tree();
    }

    /// First match at or below where the search started.
    fn search_from_origin(&mut self) {
        let Some(s) = &self.search else { return };
        if s.matches.is_empty() {
            return;
        }
        let origin = self.search_origin;
        let pos = s
            .matches
            .iter()
            .position(|m| self.doc.line_row.get(&(m.f as u32, m.h as u32, m.l as u32)).is_some_and(|&r| r > origin))
            .unwrap_or(0);
        self.show_match(pos);
    }

    fn search_step(&mut self, dir: isize) {
        let Some(s) = &self.search else { return };
        let n = s.matches.len();
        if n == 0 {
            let q = s.query.clone();
            self.flash(format!("no matches for {q}"));
            return;
        }
        let i = (s.cur as isize + dir).rem_euclid(n as isize) as usize;
        self.show_match(i);
    }

    fn update_search(&mut self) {
        self.search = self.run_search(&self.input.clone());
        if self.search.is_some() {
            self.search_from_origin();
        } else {
            self.scroll = self.search_origin.min(self.max_scroll());
        }
    }

    // ---- tree filter -----------------------------------------------------

    fn open_filter(&mut self) {
        self.mode = Mode::Filter;
        self.filter_origin = self.filter.clone();
        self.input = self.filter.clone();
    }

    fn set_filter(&mut self, q: &str) {
        let q = q.trim();
        if q == self.filter {
            return;
        }
        self.filter = q.to_string();
        if self.filter_on() {
            // Open folders that hold a match, so the tree shows every hit.
            let (files, filter) = (&self.files, &self.filter);
            self.collapsed_dirs.retain(|d| {
                let pre = format!("{d}/");
                !files.iter().any(|f| f.path.starts_with(&pre) && tree::matches(filter, &f.path))
            });
        }
        self.refilter();
    }

    /// Returns false when there was no filter to clear.
    fn clear_filter(&mut self) -> bool {
        if !self.filter_on() {
            return false;
        }
        self.set_filter("");
        self.flash("filter cleared");
        true
    }

    // ---- go to file ------------------------------------------------------

    fn open_goto(&mut self) {
        self.mode = Mode::GoTo;
        self.input.clear();
        self.goto_cur = 0;
        self.update_goto();
    }

    fn update_goto(&mut self) {
        let mut order = self.visible.clone();
        let shown: HashSet<usize> = order.iter().copied().collect();
        order.extend((0..self.files.len()).filter(|i| !shown.contains(i)));
        if self.input.trim().is_empty() {
            self.goto = order.into_iter().map(|i| (i, Vec::new())).collect();
        } else {
            let mut scored: Vec<(i64, usize, usize, Vec<usize>)> = order
                .iter()
                .enumerate()
                .filter_map(|(rank, &i)| fuzzy::score(&self.input, &self.files[i].path).map(|(s, p)| (s, rank, i, p)))
                .collect();
            scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
            self.goto = scored.into_iter().map(|(_, _, i, p)| (i, p)).collect();
        }
        self.goto_cur = self.goto_cur.min(self.goto.len().saturating_sub(1));
    }

    // ---- mouse selection ---------------------------------------------------

    /// The code on doc row `row` (its right side in split view when `right`).
    fn code_cell(&self, row: usize, right: bool) -> Option<CodeCell> {
        let g = &self.doc.geo;
        let (f, h, l, seg, x, w) = match *self.doc.rows.get(row)? {
            Row::Uni { f, h, l, seg } => {
                let single = self.files[f as usize].one_sided();
                let gw = if single { g.gutter1() } else { g.gutter2() };
                (f, h, l as usize, seg, gw + Geo::SIGN, g.uni_code_w(single))
            }
            Row::Split { f, h, p, seg } => {
                let (lo, ro) = self.files[f as usize].hunks[h as usize].pairs[p as usize];
                let l = if right { ro } else { lo }?;
                let x0 = if right { g.left_w() + 1 } else { 0 };
                (f, h, l, seg, x0 + g.gutter1() + Geo::SIGN, g.side_code_w(right))
            }
            _ => return None,
        };
        let (f, h) = (f as usize, h as usize);
        let text = &self.files[f].hunks[h].lines[l].text;
        let (range, skip) = if self.wrap {
            (doc::wrap_ranges(text, w).get(seg as usize)?.clone(), 0)
        } else if seg == 0 {
            (0..text.len(), self.hscroll)
        } else {
            return None;
        };
        Some(CodeCell { f, h, l, x: x as u16, w, range, skip })
    }

    fn cell_text(&self, c: &CodeCell) -> &str {
        &self.files[c.f].hunks[c.h].lines[c.l].text
    }

    /// Byte of the row's line under pane column `col`, or just past that
    /// character with `after` (a selection's inclusive end). Left of the code
    /// is the row's start; right of it, the row's end.
    fn byte_at(&self, c: &CodeCell, col: u16, after: bool) -> usize {
        if col < c.x {
            return c.range.start;
        }
        let want = (col - c.x) as usize;
        if want >= c.w {
            return c.range.end;
        }
        let want = want + c.skip;
        let mut cx = 0;
        for (i, ch) in self.cell_text(c)[c.range.clone()].char_indices() {
            cx += ch.width().unwrap_or(0);
            if want < cx {
                let i = c.range.start + i;
                return if after { i + ch.len_utf8() } else { i };
            }
        }
        c.range.end
    }

    /// The selection's ends in order, and its side, once it's drawn.
    fn sel_bounds(&self) -> Option<(Pos, Pos, bool)> {
        let s = self.sel.as_ref().filter(|s| s.shown)?;
        Some((s.anchor.min(s.head), s.anchor.max(s.head), s.right))
    }

    /// The selected bytes of doc row `row`'s line.
    fn sel_on(&self, row: usize) -> Option<(CodeCell, Range<usize>)> {
        let (a, b, right) = self.sel_bounds()?;
        if row < a.row || row > b.row {
            return None;
        }
        let c = self.code_cell(row, right)?;
        let s = if row == a.row { self.byte_at(&c, a.col, false) } else { c.range.start };
        let e = if row == b.row { self.byte_at(&c, b.col, true) } else { c.range.end };
        Some((c, s..e.max(s)))
    }

    /// Pane columns to paint as selected on doc row `row`.
    pub fn sel_cols(&self, row: usize) -> Option<Range<u16>> {
        let (c, r) = self.sel_on(row)?;
        let text = self.cell_text(&c);
        let col = |b: usize| c.x + text[c.range.start..b].width().saturating_sub(c.skip).min(c.w) as u16;
        let (x0, x1) = (col(r.start), col(r.end));
        // A blank line inside the selection still shows that it's taken.
        let blank = c.range.is_empty() && self.sel_bounds().is_some_and(|(_, b, _)| row < b.row);
        Some(x0..if blank { x0 + 1 } else { x1 })
    }

    /// What the selection copies: each line's selected code, one per line.
    pub fn sel_text(&self) -> String {
        let Some((a, b, _)) = self.sel_bounds() else { return String::new() };
        let mut out = String::new();
        let mut last = None;
        for row in a.row..=b.row {
            let Some((c, r)) = self.sel_on(row) else { continue };
            // A drag started past the end of a line doesn't open with a blank one.
            if row == a.row && r.is_empty() {
                continue;
            }
            let id = (c.f, c.h, c.l);
            // Wrapped segments of one line join back up.
            if last.is_some_and(|l| l != id) {
                out.push('\n');
            }
            last = Some(id);
            out.push_str(&self.cell_text(&c)[r]);
        }
        out
    }

    /// The cell under the mouse as a selection point. Above the code (the
    /// sticky header) is the start of the top row, below it the end of the
    /// bottom one.
    fn pane_pos(&self, x: u16, y: u16) -> Pos {
        let d = self.lay.diff;
        let top = d.y + u16::from(self.sticky().is_some());
        let last = d.bottom().saturating_sub(1).max(top);
        let col = if y < top {
            0
        } else if y > last {
            u16::MAX
        } else {
            x.saturating_sub(d.x)
        };
        Pos { row: self.scroll + (y.clamp(top, last) - d.y) as usize, col }
    }

    fn right_side(&self, x: u16) -> bool {
        self.doc.geo.split && x.saturating_sub(self.lay.diff.x) as usize > self.doc.geo.left_w()
    }

    fn extend_sel(&mut self, x: u16, y: u16) {
        let head = self.pane_pos(x, y);
        if let Some(s) = self.sel.as_mut() {
            s.shown |= head != s.anchor;
            s.head = head;
        }
    }

    fn copy_sel(&mut self) {
        let text = self.sel_text();
        if text.is_empty() {
            self.sel = None;
            return;
        }
        let ok = self.clip(&text);
        let n = text.lines().count();
        let msg = if !ok {
            "copy failed".to_string()
        } else if n > 1 {
            format!("copied {n} lines")
        } else {
            let t = text.trim();
            let cut: String = t.chars().take(48).collect();
            format!("copied {cut}{}", if cut.len() < t.len() { "…" } else { "" })
        };
        self.flash(msg);
    }

    /// Double click: the word under the mouse.
    fn select_word(&mut self, p: Pos, right: bool) {
        let Some(c) = self.code_cell(p.row, right) else { return };
        let seg = &self.cell_text(&c)[c.range.clone()];
        let k = self.byte_at(&c, p.col, false) - c.range.start;
        let word = |ch: char| ch.is_alphanumeric() || ch == '_';
        let s = seg[..k].char_indices().rev().take_while(|&(_, ch)| word(ch)).last().map_or(k, |(i, _)| i);
        let e = seg[k..].char_indices().find(|&(_, ch)| !word(ch)).map_or(seg.len(), |(i, _)| k + i);
        if s == e {
            return;
        }
        let col = |b: usize| c.x + seg[..b].width().saturating_sub(c.skip) as u16;
        let (anchor, head) = (Pos { row: p.row, col: col(s) }, Pos { row: p.row, col: col(e).saturating_sub(1) });
        self.sel = Some(Sel { anchor, head, right, shown: true });
        self.copy_sel();
    }

    /// Triple click: the whole line under the mouse, every wrapped row of it.
    fn select_line(&mut self, p: Pos, right: bool) {
        let Some(c) = self.code_cell(p.row, right) else { return };
        let id = (c.f, c.h, c.l);
        let same = |r: usize| self.code_cell(r, right).is_some_and(|x| (x.f, x.h, x.l) == id);
        let (mut a, mut b) = (p.row, p.row);
        while a > 0 && same(a - 1) {
            a -= 1;
        }
        while same(b + 1) {
            b += 1;
        }
        let (anchor, head) = (Pos { row: a, col: 0 }, Pos { row: b, col: u16::MAX });
        self.sel = Some(Sel { anchor, head, right, shown: true });
        self.copy_sel();
    }

    /// Left button released without dragging: fold a header, or count the
    /// click toward a double / triple click.
    fn click(&mut self, x: u16, y: u16) {
        let ry = y.saturating_sub(self.lay.diff.y) as usize;
        let header = if ry == 0 { self.sticky() } else { None }.or_else(|| match self.doc.rows.get(self.scroll + ry) {
            Some(Row::File { f }) => Some(*f as usize),
            _ => None,
        });
        if let Some(f) = header {
            self.clicks = None;
            self.toggle_fold(f);
            return;
        }
        let n = match self.clicks {
            Some((t, cx, cy, n)) if (cx, cy) == (x, y) && t.elapsed() < MULTI_CLICK => (n + 1).min(3),
            _ => 1,
        };
        self.clicks = Some((Instant::now(), x, y, n));
        let (p, right) = (self.pane_pos(x, y), self.right_side(x));
        match n {
            2 => self.select_word(p, right),
            3 => self.select_line(p, right),
            _ => {}
        }
    }

    /// Mid-drag past the top or bottom of the diff: which way to scroll.
    fn drag_edge(&self) -> Option<isize> {
        let d = self.drag.as_ref().filter(|d| d.to != d.from)?;
        let a = self.lay.diff;
        let top = a.y + u16::from(self.sticky().is_some());
        match d.to.1 {
            y if y < top => Some(-1),
            y if y >= a.bottom() => Some(1),
            _ => None,
        }
    }

    /// The event loop polls faster while this is true, to keep scrolling.
    pub fn autoscrolling(&self) -> bool {
        self.drag_edge().is_some()
    }

    /// Scroll a drag held past the edge on by a row. True when it moved.
    pub fn autoscroll(&mut self) -> bool {
        let Some(dir) = self.drag_edge() else { return false };
        if self.scrolled_at.elapsed() < AUTOSCROLL {
            return false;
        }
        self.scrolled_at = Instant::now();
        let before = self.scroll;
        self.scroll_by(dir);
        if let Some((x, y)) = self.drag.as_ref().map(|d| d.to) {
            self.extend_sel(x, y);
        }
        self.scroll != before
    }

    // ---- input -----------------------------------------------------------

    pub fn handle(&mut self, ev: Event) -> Act {
        match ev {
            Event::Key(k) if k.kind != KeyEventKind::Release => self.key(k),
            Event::Paste(s) => {
                self.paste(&s);
                Act::None
            }
            Event::Mouse(m) => {
                self.mouse(m);
                Act::None
            }
            _ => Act::None,
        }
    }

    fn key(&mut self, k: KeyEvent) -> Act {
        // Any key drops a mouse selection; Esc does only that. (`c` reads it first.)
        let sel = self.sel.take();
        if sel.as_ref().is_some_and(|s| s.shown) && k.code == KeyCode::Esc && self.mode == Mode::Normal {
            return Act::None;
        }
        match self.mode {
            Mode::Help => {
                self.mode = Mode::Normal;
                return Act::None;
            }
            Mode::Ask => {
                self.key_ask(k);
                return Act::None;
            }
            Mode::Tabs => {
                self.key_tabs(k);
                return Act::None;
            }
            Mode::Search => {
                self.key_search(k);
                return Act::None;
            }
            Mode::Filter => {
                self.key_filter(k);
                return Act::None;
            }
            Mode::GoTo => {
                self.key_goto(k);
                return Act::None;
            }
            Mode::Normal => {}
        }
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        // Vim counts: 5j, 3J, 2}, 12G. A leading 0 is its own key.
        if let (KeyCode::Char(c @ '0'..='9'), false) = (k.code, ctrl) {
            if c != '0' || self.count.is_some() {
                let d = c as usize - '0' as usize;
                self.count = Some((self.count.unwrap_or(0) * 10 + d).min(99_999));
                return Act::None;
            }
        }
        let count = self.count.take();
        let n = count.unwrap_or(1).max(1) as isize;
        self.mark = None;
        let h = self.lay.diff.height as isize;
        let (half, page) = ((h / 2).max(1), (h - 2).max(1));
        match (k.code, ctrl) {
            (KeyCode::Esc, _) if count.is_some() => {}
            (KeyCode::Char('c'), true) | (KeyCode::Char('q'), false) => return Act::Quit,
            // ^d ^u in the tree move it like vim; plain d u still scroll the diff.
            (KeyCode::Char('d'), true) if self.tree_on() => self.tree_half_page(n),
            (KeyCode::Char('u'), true) if self.tree_on() => self.tree_half_page(-n),
            (KeyCode::Char('d'), _) => self.scroll_by(half * n),
            (KeyCode::Char('u'), _) => self.scroll_by(-half * n),
            (KeyCode::Char('e'), true) => self.scroll_by(n),
            (KeyCode::Char('y'), true) => self.scroll_by(-n),
            (KeyCode::Char('f'), _) | (KeyCode::PageDown, _) | (KeyCode::Char(' '), false) => self.scroll_by(page * n),
            (KeyCode::Char('b'), _) | (KeyCode::PageUp, _) => self.scroll_by(-page * n),
            (KeyCode::Char('o'), true) => self.jump_back(),
            (KeyCode::Char('p'), true) | (KeyCode::Char('t'), false) => self.open_goto(),
            (KeyCode::Char('?'), _) | (KeyCode::F(1), _) => self.mode = Mode::Help,
            (KeyCode::Tab | KeyCode::BackTab, _) => {
                self.focus = if self.focus == Focus::Tree || self.lay.tree.width == 0 { Focus::Diff } else { Focus::Tree };
            }
            (KeyCode::Char('e'), false) => {
                self.show_tree = !self.show_tree;
                self.focus = if self.show_tree { Focus::Tree } else { Focus::Diff };
            }
            (KeyCode::Char(c @ ('<' | '>')), _) => {
                self.show_tree = true;
                let step = if c == '>' { 4 } else { -4 } * n as i32;
                let cur = if self.lay.tree.width > 0 { self.lay.tree.width } else { self.tree_w };
                self.tree_fixed = Some((cur as i32 + step).max(16) as u16);
            }
            (KeyCode::Char('s'), false) => self.set_split(!self.doc.geo.split),
            (KeyCode::Char('w'), false) => {
                self.wrap = !self.wrap;
                self.hscroll = 0;
                self.rebuild_doc();
                self.flash(if self.wrap { "wrapping long lines" } else { "not wrapping · h/l scroll sideways" });
            }
            (KeyCode::Char('0'), false) => self.hscroll = 0,
            (KeyCode::Char('T'), _) => self.toggle_tests(),
            (KeyCode::Char('/'), false) if self.tree_on() => self.open_filter(),
            (KeyCode::Char('/'), false) => {
                self.mode = Mode::Search;
                self.input.clear();
                self.search_origin = self.scroll;
            }
            (KeyCode::Char('n'), false) if self.search.is_some() => self.search_step(n),
            (KeyCode::Char('N'), _) if self.search.is_some() => self.search_step(-n),
            (KeyCode::Char('J' | ']' | 'n'), _) => (0..n).for_each(|_| self.next_file(1)),
            (KeyCode::Char('K' | '[' | 'N' | 'p'), _) => (0..n).for_each(|_| self.next_file(-1)),
            (KeyCode::Char('}'), _) => (0..n).for_each(|_| self.next_hunk(1)),
            (KeyCode::Char('{'), _) => (0..n).for_each(|_| self.next_hunk(-1)),
            (KeyCode::Char('g'), false) | (KeyCode::Home, _) => match count {
                Some(c) => self.goto_count(c),
                None => self.go_top(),
            },
            (KeyCode::Char('G'), _) | (KeyCode::End, _) => match count {
                Some(c) => self.goto_count(c),
                None => self.go_bottom(),
            },
            (KeyCode::Char('x'), false) => self.toggle_viewed(),
            (KeyCode::Char('z'), false) => {
                if let Some(f) = self.cur_file() {
                    self.toggle_fold(f);
                }
            }
            (KeyCode::Char('Z'), _) => self.fold_all(),
            (KeyCode::Char('o'), false) => return self.open_editor(),
            (KeyCode::Char('O'), _) => self.open_github(),
            (KeyCode::Char('y'), false) => self.copy(false),
            (KeyCode::Char('Y'), _) => self.copy(true),
            (KeyCode::Char('r'), false) => self.reload(),
            (KeyCode::Char('c'), false) => self.open_ask(sel.as_ref()),
            (KeyCode::Char(';'), false) => self.open_tabs(),
            // The focused pane's filter or search goes first, then the other's.
            (KeyCode::Esc, _) => {
                let tree = self.tree_on();
                let cleared = (tree && self.clear_filter())
                    || self.search.take().is_some()
                    || (!tree && self.clear_filter());
                if !cleared {
                    self.msg = None;
                }
            }
            _ => {
                let focus = if self.lay.tree.width == 0 { Focus::Diff } else { self.focus };
                match focus {
                    Focus::Tree => self.key_tree(k, n),
                    Focus::Diff => self.key_diff(k, n),
                }
            }
        }
        Act::None
    }

    fn key_tree(&mut self, k: KeyEvent, n: isize) {
        match k.code {
            KeyCode::Char('j') | KeyCode::Down => self.tree_move(n),
            KeyCode::Char('k') | KeyCode::Up => self.tree_move(-n),
            KeyCode::Char('h') | KeyCode::Left => self.tree_left(),
            KeyCode::Char('l') | KeyCode::Right => self.tree_activate(false),
            KeyCode::Enter => self.tree_activate(true),
            _ => {}
        }
    }

    fn key_diff(&mut self, k: KeyEvent, n: isize) {
        let side = 8 * n as usize;
        match k.code {
            KeyCode::Char('j') | KeyCode::Down => self.scroll_by(n),
            KeyCode::Char('k') | KeyCode::Up => self.scroll_by(-n),
            KeyCode::Char('h') | KeyCode::Left if !self.wrap => self.hscroll = self.hscroll.saturating_sub(side),
            KeyCode::Char('l') | KeyCode::Right if !self.wrap => self.hscroll += side,
            KeyCode::Char('h') | KeyCode::Left if self.lay.tree.width > 0 => self.focus = Focus::Tree,
            _ => {}
        }
    }

    fn edit_input(&mut self, k: &KeyEvent) -> bool {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        match k.code {
            KeyCode::Backspace => {
                self.input.pop();
            }
            KeyCode::Char('u') if ctrl => self.input.clear(),
            KeyCode::Char('w') if ctrl => {
                let t = self.input.trim_end().len();
                let cut = self.input[..t].rfind(|c: char| c.is_whitespace() || c == '/').map_or(0, |i| i + 1);
                self.input.truncate(cut);
            }
            KeyCode::Char(c) if !ctrl => self.input.push(c),
            _ => return false,
        }
        true
    }

    fn key_search(&mut self, k: KeyEvent) {
        match k.code {
            KeyCode::Esc => {
                self.mode = Mode::Normal;
                self.search = None;
                self.scroll = self.search_origin.min(self.max_scroll());
                self.sync_tree();
            }
            KeyCode::Enter => {
                self.mode = Mode::Normal;
                match &self.search {
                    None => {}
                    Some(s) if s.matches.is_empty() => {
                        let q = s.query.clone();
                        self.search = None;
                        self.flash(format!("no matches for {q}"));
                    }
                    Some(_) => self.push_jump_at(self.search_origin),
                }
            }
            _ => {
                if self.edit_input(&k) {
                    self.update_search();
                }
            }
        }
    }

    fn key_filter(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        match k.code {
            KeyCode::Esc => {
                self.mode = Mode::Normal;
                let origin = std::mem::take(&mut self.filter_origin);
                self.set_filter(&origin);
            }
            KeyCode::Enter => {
                self.mode = Mode::Normal;
                if self.filter_on() && self.visible.is_empty() {
                    let q = self.filter.clone();
                    self.flash(format!("no files match {q} · esc clears"));
                }
            }
            KeyCode::Down | KeyCode::Tab => self.tree_move(1),
            KeyCode::Up | KeyCode::BackTab => self.tree_move(-1),
            KeyCode::Char('n' | 'j') if ctrl => self.tree_move(1),
            KeyCode::Char('p' | 'k') if ctrl => self.tree_move(-1),
            _ => {
                if self.edit_input(&k) {
                    let q = self.input.clone();
                    self.set_filter(&q);
                }
            }
        }
    }

    fn key_goto(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        match k.code {
            KeyCode::Esc => self.mode = Mode::Normal,
            KeyCode::Enter => {
                self.mode = Mode::Normal;
                if let Some(&(f, _)) = self.goto.get(self.goto_cur) {
                    if !self.visible.contains(&f) {
                        if !tree::matches(&self.filter, &self.files[f].path) {
                            self.filter.clear();
                            self.flash("filter cleared");
                        }
                        if self.files[f].is_test {
                            self.show_tests = true;
                        }
                        self.refilter();
                    }
                    if self.is_collapsed(f) {
                        self.fold.insert(f, false);
                        self.rebuild_doc();
                    }
                    self.push_jump();
                    self.jump_file(f);
                }
            }
            KeyCode::Up => self.goto_cur = self.goto_cur.saturating_sub(1),
            KeyCode::Char('p' | 'k') if ctrl => self.goto_cur = self.goto_cur.saturating_sub(1),
            KeyCode::Down | KeyCode::Tab => self.goto_cur = (self.goto_cur + 1).min(self.goto.len().saturating_sub(1)),
            KeyCode::Char('n' | 'j') if ctrl => self.goto_cur = (self.goto_cur + 1).min(self.goto.len().saturating_sub(1)),
            _ => {
                if self.edit_input(&k) {
                    self.goto_cur = 0;
                    self.update_goto();
                }
            }
        }
    }

    fn mouse(&mut self, m: MouseEvent) {
        if self.mode != Mode::Normal {
            return;
        }
        let (x, y) = (m.column, m.row);
        let inside = |r: Rect| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
        let (tree, diff) = (self.lay.tree, self.lay.diff);
        match m.kind {
            MouseEventKind::ScrollDown if inside(tree) => {
                self.tree_top += 3;
                self.clamp_tree_top();
            }
            MouseEventKind::ScrollUp if inside(tree) => self.tree_top = self.tree_top.saturating_sub(3),
            MouseEventKind::ScrollDown | MouseEventKind::ScrollUp => {
                self.scroll_by(if m.kind == MouseEventKind::ScrollDown { 3 } else { -3 });
                // Wheeling mid-drag carries the selection along.
                if self.drag.is_some() {
                    self.extend_sel(x, y);
                }
            }
            // Selections are kept in screen columns, so sideways scrolling drops them.
            MouseEventKind::ScrollRight if !self.wrap => {
                self.hscroll += 4;
                self.sel = None;
            }
            MouseEventKind::ScrollLeft if !self.wrap => {
                self.hscroll = self.hscroll.saturating_sub(4);
                self.sel = None;
            }
            MouseEventKind::Down(MouseButton::Left) if inside(tree) => {
                self.focus = Focus::Tree;
                let i = self.tree_top + (y - tree.y) as usize;
                if i < self.tree_rows.len() {
                    self.tree_cur = i;
                    self.tree_activate(true);
                    self.focus = Focus::Tree;
                }
            }
            // Press starts a selection; it's drawn once the drag leaves the
            // first cell and copied on release. A release in place is a click.
            MouseEventKind::Down(MouseButton::Left) if inside(diff) => {
                self.focus = Focus::Diff;
                let p = self.pane_pos(x, y);
                self.sel = Some(Sel { anchor: p, head: p, right: self.right_side(x), shown: false });
                self.drag = Some(Drag { from: (x, y), to: (x, y) });
            }
            MouseEventKind::Drag(MouseButton::Left) if self.drag.is_some() => {
                if let Some(d) = self.drag.as_mut() {
                    d.to = (x, y);
                }
                self.extend_sel(x, y);
            }
            MouseEventKind::Up(MouseButton::Left) => {
                let Some(d) = self.drag.take() else { return };
                if self.sel.as_ref().is_some_and(|s| s.shown) {
                    self.copy_sel();
                } else {
                    self.sel = None;
                    self.click(d.from.0, d.from.1);
                }
            }
            _ => {}
        }
    }
}
