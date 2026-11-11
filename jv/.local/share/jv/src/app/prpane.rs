//! jp's left pane: the PR list (prs.rs finds the PRs), and swapping the diff
//! on the right for whichever PR it selects. Diffs come from `gh pr diff` on
//! background threads, a few at a time, and stay cached for the session; the
//! PRs next to the cursor are fetched ahead of it, so j/k through the list
//! rarely waits. Each PR keeps its own scroll, folds and tree state.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEventKind};

use super::{Act, Anchor, App, Focus, Left, Mode};
use crate::diff;
use crate::prs::{self, Pr, Query};
use crate::source::{self, PrMeta, Source};
use crate::tree;

/// `gh pr diff`s running at once.
const PARALLEL: usize = 4;
/// PRs below the cursor fetched ahead of it (and one above).
const AHEAD: usize = 2;

pub struct Fetched {
    pub text: String,
    note: Option<String>,
    /// Each file's (hash, is_test): the list's viewed counts and `x` read it.
    pub files: Vec<(u64, bool)>,
}

impl Fetched {
    fn new(text: String, note: Option<String>) -> Self {
        let files = diff::parse(&text).files.iter().map(|f| (f.hash, f.is_test)).collect();
        Fetched { text, note, files }
    }
}

type Got = Result<Fetched, String>;

/// Where a PR was left: put back when the list comes back to it.
struct View {
    anchor: Option<Anchor>,
    fold: HashMap<usize, bool>,
    collapsed: HashSet<String>,
    tree_cur: usize,
    tree_top: usize,
    hscroll: usize,
}

pub struct PrPane {
    pub query: Query,
    pub items: Vec<Pr>,
    /// Indexes into `items` that the filter keeps, in list order.
    pub shown: Vec<usize>,
    /// Position in `shown`.
    pub cur: usize,
    pub top: usize,
    pub filter: String,
    filter_origin: String,
    /// The PR whose diff `App::files` holds. None while it's loading.
    loaded: Option<String>,
    cache: HashMap<String, Got>,
    inflight: HashSet<String>,
    queue: VecDeque<String>,
    views: HashMap<String, View>,
    tx: mpsc::Sender<(String, Got)>,
    rx: mpsc::Receiver<(String, Got)>,
    /// A list search in flight: the CI fill-in after startup, or `R`.
    list_rx: Option<mpsc::Receiver<Result<Vec<Pr>, String>>>,
    /// Say how the list search went (`R`); the startup fill-in is quiet.
    announce: bool,
}

impl PrPane {
    pub fn all_repos(&self) -> bool {
        self.query.repo.is_none()
    }

    pub fn refreshing(&self) -> bool {
        self.list_rx.is_some()
    }

    pub fn filter_on(&self) -> bool {
        !self.filter.is_empty()
    }

    pub fn cur_item(&self) -> Option<&Pr> {
        self.shown.get(self.cur).map(|&i| &self.items[i])
    }

    fn cur_key(&self) -> Option<String> {
        self.cur_item().map(Pr::key)
    }

    fn refilter(&mut self) {
        let keep = self.cur_key();
        self.shown = (0..self.items.len()).filter(|&i| tree::matches(&self.filter, &self.items[i].haystack())).collect();
        self.cur = keep.and_then(|k| self.shown.iter().position(|&i| self.items[i].key() == k)).unwrap_or(0);
    }
}

fn meta_of(pr: &Pr) -> PrMeta {
    PrMeta {
        number: pr.number.to_string(),
        title: pr.title.clone(),
        author: pr.author.clone(),
        head: pr.head.clone(),
        base: pr.base.clone(),
        draft: pr.draft,
        state: pr.state.clone(),
        url: pr.url.clone(),
    }
}

impl App {
    /// Turn this App into jp: the list on the left, its first PR on the right.
    pub fn start_prs(&mut self, query: Query, items: Vec<Pr>) {
        let (tx, rx) = mpsc::channel();
        let mut pane = PrPane {
            query,
            items,
            shown: Vec::new(),
            cur: 0,
            top: 0,
            filter: String::new(),
            filter_origin: String::new(),
            loaded: None,
            cache: HashMap::new(),
            inflight: HashSet::new(),
            queue: VecDeque::new(),
            views: HashMap::new(),
            tx,
            rx,
            list_rx: None,
            announce: false,
        };
        pane.refilter();
        self.prs = Some(pane);
        self.left = Left::Prs;
        self.focus = Focus::Tree;
        self.apply_pr();
        // The first list skipped CI (it halves the wait); fill it in now.
        self.spawn_list(false);
    }

    /// The PR list has the keys: it's on screen and focused.
    pub fn prs_on(&self) -> bool {
        self.prs.is_some() && self.left == Left::Prs && self.focus == Focus::Tree && self.lay.tree.width > 0
    }

    /// Background work the event loop should wake up for sooner.
    pub fn pr_fetching(&self) -> bool {
        self.prs.as_ref().is_some_and(|p| !p.inflight.is_empty() || p.list_rx.is_some())
    }

    /// What the diff pane says instead of a diff: the PR is still loading, or
    /// gh failed.
    pub fn pr_placeholder(&self) -> Option<String> {
        let p = self.prs.as_ref()?;
        let pr = p.cur_item()?;
        match p.cache.get(&pr.key()) {
            None => Some(format!("Loading #{} · {} file{}…", pr.number, pr.files, if pr.files == 1 { "" } else { "s" })),
            Some(Err(e)) => Some(format!("gh pr diff #{} failed: {}  ·  r retries", pr.number, e.lines().next().unwrap_or(""))),
            Some(Ok(_)) => None,
        }
    }

    /// (viewed, files) for a PR whose diff has loaded.
    pub fn pr_viewed(&self, pr: &Pr) -> Option<(usize, usize)> {
        let Some(Ok(f)) = self.prs.as_ref()?.cache.get(&pr.key()) else { return None };
        let files: Vec<u64> = f.files.iter().filter(|(_, t)| self.show_tests || !t).map(|(h, _)| *h).collect();
        Some((files.iter().filter(|&&h| self.viewed.has(h)).count(), files.len()))
    }

    // ---- switching the diff ------------------------------------------------

    /// Put the selected PR's diff on the right: from the cache, or a
    /// placeholder while it's fetched. Moving the cursor doesn't call this;
    /// `poll_prs` does, once per frame, so holding j parses only the PR it
    /// stops on.
    fn apply_pr(&mut self) {
        let Some(p) = self.prs.as_ref() else { return };
        let Some(pr) = p.cur_item().cloned() else { return };
        let key = pr.key();
        if p.loaded.as_deref() == Some(key.as_str()) {
            return;
        }
        self.save_view();
        self.meta = Some(meta_of(&pr));
        self.source = Source::Gh(pr.diff_args());
        let p = self.prs.as_mut().expect("pr mode");
        let cached = match p.cache.get(&key) {
            Some(Ok(f)) => Some((f.text.clone(), f.note.clone())),
            Some(Err(_)) => Some((String::new(), None)),
            None => None,
        };
        p.loaded = cached.as_ref().map(|_| key.clone());
        match cached {
            Some((text, note)) => {
                self.load_files(&text);
                self.restore_view(&key);
                if let Some(n) = note {
                    self.flash(n);
                }
            }
            None => {
                self.load_files("");
                self.request(key, true);
            }
        }
        self.prefetch_near();
    }

    fn save_view(&mut self) {
        let Some(key) = self.prs.as_ref().and_then(|p| p.loaded.clone()) else { return };
        let v = View {
            anchor: self.anchor(),
            fold: self.fold.clone(),
            collapsed: self.collapsed_dirs.clone(),
            tree_cur: self.tree_cur,
            tree_top: self.tree_top,
            hscroll: self.hscroll,
        };
        if let Some(p) = self.prs.as_mut() {
            p.views.insert(key, v);
        }
    }

    fn restore_view(&mut self, key: &str) {
        let Some(v) = self.prs.as_mut().and_then(|p| p.views.remove(key)) else { return };
        self.fold = v.fold;
        self.collapsed_dirs = v.collapsed;
        self.hscroll = v.hscroll;
        self.refresh_tree_rows();
        self.rebuild_doc();
        self.restore(v.anchor);
        self.tree_cur = v.tree_cur.min(self.tree_rows.len().saturating_sub(1));
        self.tree_top = v.tree_top;
        self.clamp_tree_top();
    }

    /// `r` fetched this PR's diff again: keep it.
    pub(super) fn pr_reloaded(&mut self, text: &str) {
        let Some(p) = self.prs.as_mut() else { return };
        let Some(key) = p.cur_key() else { return };
        p.cache.insert(key.clone(), Ok(Fetched::new(text.to_string(), None)));
        p.loaded = Some(key);
    }

    // ---- fetching ------------------------------------------------------------

    fn request(&mut self, key: String, front: bool) {
        let Some(p) = self.prs.as_mut() else { return };
        if p.cache.contains_key(&key) || p.inflight.contains(&key) {
            return;
        }
        p.queue.retain(|k| *k != key);
        if front {
            p.queue.push_front(key);
        } else {
            p.queue.push_back(key);
        }
        self.pump();
    }

    fn pump(&mut self) {
        let Some(p) = self.prs.as_mut() else { return };
        while p.inflight.len() < PARALLEL {
            let Some(key) = p.queue.pop_front() else { break };
            if p.cache.contains_key(&key) || p.inflight.contains(&key) {
                continue;
            }
            let Some(args) = p.items.iter().find(|x| x.key() == key).map(Pr::diff_args) else { continue };
            p.inflight.insert(key.clone());
            let tx = p.tx.clone();
            thread::spawn(move || {
                let got = Source::Gh(args).fetch_noted().map(|(t, n)| Fetched::new(t, n));
                let _ = tx.send((key, got));
            });
        }
    }

    fn prefetch_near(&mut self) {
        let Some(p) = self.prs.as_ref() else { return };
        let near: Vec<String> = (1..=AHEAD)
            .map(|d| p.cur + d)
            .chain(p.cur.checked_sub(1))
            .filter_map(|i| p.shown.get(i).map(|&ix| p.items[ix].key()))
            .collect();
        for k in near {
            self.request(k, false);
        }
    }

    fn spawn_list(&mut self, announce: bool) {
        let Some(p) = self.prs.as_mut() else { return };
        if p.list_rx.is_some() {
            return;
        }
        let (tx, rx) = mpsc::channel();
        let q = p.query.clone();
        thread::spawn(move || {
            let _ = tx.send(prs::list(&q, true));
        });
        p.list_rx = Some(rx);
        p.announce = announce;
    }

    /// Take in finished fetches. Returns true when a redraw is needed.
    pub fn poll_prs(&mut self) -> bool {
        let Some(p) = self.prs.as_mut() else { return false };
        let mut dirty = false;
        while let Ok((key, got)) = p.rx.try_recv() {
            p.inflight.remove(&key);
            p.cache.insert(key, got);
            dirty = true;
        }
        let list = match &p.list_rx {
            Some(rx) => match rx.try_recv() {
                Ok(r) => Some(r),
                Err(mpsc::TryRecvError::Empty) => None,
                Err(mpsc::TryRecvError::Disconnected) => Some(Err("the PR search stopped".into())),
            },
            None => None,
        };
        if let Some(r) = list {
            p.list_rx = None;
            let announce = p.announce;
            dirty = true;
            match r {
                Ok(items) => {
                    let n = items.len();
                    self.merge_list(items);
                    if announce {
                        self.flash(format!("refreshed · {n} PRs"));
                    }
                }
                Err(e) => self.flash(format!("PR list: {}", e.lines().next().unwrap_or(""))),
            }
        }
        let before = self.prs.as_ref().and_then(|p| p.loaded.clone());
        self.apply_pr();
        let applied = self.prs.as_ref().is_some_and(|p| p.loaded != before);
        if dirty {
            self.pump();
        }
        dirty || applied
    }

    /// A fresh search result: the new order and data (CI, reviews), the same
    /// PR still selected. A PR updated since may have new commits, so its
    /// diff is fetched again.
    fn merge_list(&mut self, items: Vec<Pr>) {
        let Some(p) = self.prs.as_mut() else { return };
        let old: HashMap<String, i64> = p.items.iter().map(|x| (x.key(), x.updated)).collect();
        for it in &items {
            let k = it.key();
            if old.get(&k).is_some_and(|&u| u != it.updated) {
                p.cache.remove(&k);
                p.views.remove(&k);
                if p.loaded.as_ref() == Some(&k) {
                    p.loaded = None;
                }
            }
        }
        p.items = items;
        p.refilter();
        self.ensure_pr_visible();
    }

    /// For `--snapshot`: wait for the selected PR's diff and the list search.
    pub fn settle(&mut self) {
        let start = Instant::now();
        loop {
            self.poll_prs();
            let Some(p) = self.prs.as_ref() else { return };
            let waiting = p.cur_key().is_some_and(|k| !p.cache.contains_key(&k)) || p.list_rx.is_some();
            if !waiting || start.elapsed() > Duration::from_secs(30) {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    // ---- moving --------------------------------------------------------------

    /// PRs the list has room for (two rows each).
    fn pr_rows(&self) -> usize {
        (self.lay.tree.height as usize / 2).max(1)
    }

    pub(super) fn ensure_pr_visible(&mut self) {
        let h = self.pr_rows();
        let Some(p) = self.prs.as_mut() else { return };
        let so = 1.min(h / 2);
        if p.cur < p.top + so {
            p.top = p.cur.saturating_sub(so);
        }
        if p.cur + so >= p.top + h {
            p.top = p.cur + so + 1 - h;
        }
        p.top = p.top.min(p.shown.len().saturating_sub(h));
    }

    fn pr_set(&mut self, i: usize) {
        let Some(p) = self.prs.as_mut() else { return };
        if p.shown.is_empty() {
            return;
        }
        p.cur = i.min(p.shown.len() - 1);
        self.ensure_pr_visible();
    }

    fn pr_move(&mut self, d: isize) {
        let Some(p) = self.prs.as_ref() else { return };
        self.pr_set((p.cur as isize + d).max(0) as usize);
    }

    /// ^d / ^u: like the tree's, the view and the cursor move together.
    fn pr_half_page(&mut self, pages: isize) {
        let h = self.pr_rows() as isize;
        let d = (h / 2).max(1) * pages;
        if let Some(p) = self.prs.as_mut() {
            let max_top = p.shown.len().saturating_sub(h as usize) as isize;
            p.top = (p.top as isize + d).clamp(0, max_top) as usize;
        }
        self.pr_move(d);
    }

    /// ⏎ on a PR: its files take the left pane.
    fn pr_enter(&mut self) {
        if self.prs.as_ref().and_then(PrPane::cur_item).is_none() {
            return;
        }
        self.left = Left::Files;
        self.focus = Focus::Tree;
        self.ensure_tree_visible();
    }

    /// Back from the files to the list.
    pub(super) fn pr_back(&mut self) {
        self.left = Left::Prs;
        self.focus = Focus::Tree;
        self.ensure_pr_visible();
    }

    // ---- actions -------------------------------------------------------------

    fn open_pr(&mut self) {
        let Some(pr) = self.prs.as_ref().and_then(PrPane::cur_item) else { return };
        let (url, n) = (pr.url.clone(), pr.number);
        let ok = !self.live || source::open_url(&url);
        self.flash(if ok { format!("opened #{n} on GitHub") } else { "couldn't open a browser".to_string() });
    }

    fn copy_pr(&mut self, branch: bool) {
        let Some(pr) = self.prs.as_ref().and_then(PrPane::cur_item) else { return };
        let text = if branch { pr.head.clone() } else { pr.url.clone() };
        let ok = self.clip(&text);
        self.flash(if ok { format!("copied {text}") } else { "copy failed".to_string() });
    }

    /// `x` on a PR: every file in it viewed (or, when all are, none).
    fn toggle_pr_viewed(&mut self) {
        let Some(p) = self.prs.as_ref() else { return };
        let Some(pr) = p.cur_item() else { return };
        let n = pr.number;
        let hashes: Option<Vec<u64>> = match p.cache.get(&pr.key()) {
            Some(Ok(f)) => Some(f.files.iter().filter(|(_, t)| self.show_tests || !t).map(|(h, _)| *h).collect()),
            _ => None,
        };
        let Some(hashes) = hashes else {
            self.flash(format!("#{n} is still loading"));
            return;
        };
        let on = !hashes.iter().all(|&h| self.viewed.has(h));
        self.viewed.set_many(&hashes, on);
        self.fold.clear();
        self.rebuild_doc();
        let k = hashes.len();
        self.flash(if on { format!("✓ viewed all {k} files of #{n}") } else { format!("unmarked #{n}") });
    }

    // ---- filter --------------------------------------------------------------

    fn open_pr_filter(&mut self) {
        let Some(p) = self.prs.as_mut() else { return };
        p.filter_origin = p.filter.clone();
        let f = p.filter.clone();
        self.input.set(&f);
        self.mode = Mode::PrFilter;
    }

    fn set_pr_filter(&mut self, q: &str) {
        let Some(p) = self.prs.as_mut() else { return };
        let q = q.trim();
        if q == p.filter {
            return;
        }
        p.filter = q.to_string();
        p.refilter();
        self.ensure_pr_visible();
    }

    pub(super) fn key_pr_filter(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        match k.code {
            KeyCode::Esc => {
                self.mode = Mode::Normal;
                let origin = self.prs.as_mut().map(|p| std::mem::take(&mut p.filter_origin)).unwrap_or_default();
                self.set_pr_filter(&origin);
            }
            KeyCode::Enter => {
                self.mode = Mode::Normal;
                if let Some(p) = self.prs.as_ref().filter(|p| p.filter_on() && p.shown.is_empty()) {
                    let q = p.filter.clone();
                    self.flash(format!("no PRs match {q} · esc clears"));
                }
            }
            KeyCode::Down | KeyCode::Tab => self.pr_move(1),
            KeyCode::Up | KeyCode::BackTab => self.pr_move(-1),
            KeyCode::Char('n' | 'j') if ctrl => self.pr_move(1),
            KeyCode::Char('p' | 'k') if ctrl => self.pr_move(-1),
            _ => {
                if self.input.key(&k) {
                    let q = self.input.text.clone();
                    self.set_pr_filter(&q);
                }
            }
        }
    }

    // ---- input ---------------------------------------------------------------

    /// jp's keys, ahead of jv's. None leaves the key to jv.
    pub(super) fn key_prs(&mut self, k: KeyEvent, n: isize, count: Option<usize>) -> Option<Act> {
        self.prs.as_ref()?;
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        // Anywhere: the list's own keys for when it isn't focused (or shown).
        match k.code {
            KeyCode::Char('R') => {
                self.spawn_list(true);
                self.flash("refreshing the PR list…");
                return Some(Act::None);
            }
            KeyCode::Char(')') => {
                self.pr_move(n);
                return Some(Act::None);
            }
            KeyCode::Char('(') => {
                self.pr_move(-n);
                return Some(Act::None);
            }
            KeyCode::Char('-') | KeyCode::Backspace if self.left == Left::Files => {
                self.pr_back();
                return Some(Act::None);
            }
            _ => {}
        }
        if !self.prs_on() {
            return None;
        }
        match (k.code, ctrl) {
            (KeyCode::Char('j') | KeyCode::Down, false) => self.pr_move(n),
            (KeyCode::Char('k') | KeyCode::Up, false) => self.pr_move(-n),
            (KeyCode::Char('d'), true) => self.pr_half_page(n),
            (KeyCode::Char('u'), true) => self.pr_half_page(-n),
            (KeyCode::Char('g') | KeyCode::Home, false) => self.pr_set(count.unwrap_or(1).saturating_sub(1)),
            (KeyCode::Char('G') | KeyCode::End, _) => self.pr_set(count.map_or(usize::MAX, |c| c.saturating_sub(1))),
            (KeyCode::Enter | KeyCode::Char('l') | KeyCode::Right, false) => self.pr_enter(),
            (KeyCode::Char('/'), false) => self.open_pr_filter(),
            (KeyCode::Esc, _) if count.is_none() && self.prs.as_ref().is_some_and(PrPane::filter_on) => {
                self.set_pr_filter("");
                self.flash("filter cleared");
            }
            (KeyCode::Char('O'), _) => self.open_pr(),
            (KeyCode::Char('y'), false) => self.copy_pr(false),
            (KeyCode::Char('Y'), _) => self.copy_pr(true),
            (KeyCode::Char('x'), false) => self.toggle_pr_viewed(),
            _ => return None,
        }
        Some(Act::None)
    }

    /// The mouse over the list or its header. False leaves it to jv.
    pub(super) fn mouse_prs(&mut self, kind: MouseEventKind, x: u16, y: u16) -> bool {
        if self.prs.is_none() {
            return false;
        }
        let inside = |r: ratatui::layout::Rect| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
        if inside(self.lay.head) {
            if kind == MouseEventKind::Down(MouseButton::Left) && self.left == Left::Files {
                self.pr_back();
            }
            return true;
        }
        let a = self.lay.tree;
        if self.left != Left::Prs || !inside(a) {
            return false;
        }
        let h = self.pr_rows();
        let p = self.prs.as_mut().expect("pr mode");
        match kind {
            MouseEventKind::ScrollDown => p.top = (p.top + 2).min(p.shown.len().saturating_sub(h)),
            MouseEventKind::ScrollUp => p.top = p.top.saturating_sub(2),
            // A click picks a PR; a click on the picked one opens its files.
            MouseEventKind::Down(MouseButton::Left) => {
                let i = p.top + (y - a.y) as usize / 2;
                let again = i == p.cur && self.focus == Focus::Tree;
                self.focus = Focus::Tree;
                if i < p.shown.len() {
                    if again {
                        self.pr_enter();
                    } else {
                        self.pr_set(i);
                    }
                }
            }
            _ => {}
        }
        true
    }
}
