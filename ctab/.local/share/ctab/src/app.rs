//! State and keys. The keys are jv's `;` dialog's: j/k with counts and
//! relative numbers, x or ; to close, ⏎ to go. The preview is the tab's
//! screenshot, as big as the panel allows; the page itself is never read.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use serde_json::json;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::bridge::{self, Host, Peek, PeekReq, Pixels, Snap, Tab, Thumb};
use crate::fuzzy;
use crate::gfx::{self, Gfx};
use crate::theme::Palette;

/// The tab list is re-read this often, so tabs opened or closed in Chrome show up.
const LIST_REFRESH: Duration = Duration::from_millis(1000);
/// The selected tab's screenshot is re-asked for this often.
const PEEK_REFRESH: Duration = Duration::from_millis(2500);
const MULTI_CLICK: Duration = Duration::from_millis(450);
const FLASH: Duration = Duration::from_secs(4);
/// Peeks kept for going back to a tab (a PNG each, when images are on).
const KEEP_PEEKS: usize = 24;
/// Screenshots the terminal keeps, so j/k back and forth needn't resend them.
const KEEP_IMAGES: usize = 4;

/// A preview line: runs of text, each with its style.
pub type Line = Vec<(String, Style)>;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Sort {
    /// As the tab strip has them: window by window, left to right.
    Strip,
    /// Most recently used first.
    Recent,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Normal,
    /// Typing the `/` filter.
    Filter,
    Help,
}

pub enum Act {
    None,
    Quit,
}

/// A row of the list: a window or tab-group heading, or a tab (its place in `view`).
pub enum Row {
    Header(String, Color),
    Tab(usize),
}

/// What a sent image shows: a tab's screenshot, fit to a number of cells.
#[derive(Clone, Copy, PartialEq)]
struct ImgKey {
    tab: i64,
    rev: f64,
    fit: (u16, u16),
    cols: u16,
    rows: u16,
}

/// The images ctab has sent the terminal, newest first, and the bytes not yet written.
#[derive(Default)]
struct Images {
    sent: Vec<(ImgKey, u32)>,
    out: Vec<u8>,
    next: u32,
}

impl Images {
    /// The id of `key`'s image, sending the PNG when the terminal hasn't got it.
    fn id_for(&mut self, key: ImgKey, png: &str) -> u32 {
        if let Some(i) = self.sent.iter().position(|(k, _)| *k == key) {
            let e = self.sent.remove(i);
            self.sent.insert(0, e);
            return e.1;
        }
        self.next += 1;
        let id = gfx::image_id(self.next);
        self.out.extend(gfx::transmit(id, png, key.cols, key.rows));
        self.sent.insert(0, (key, id));
        while self.sent.len() > KEEP_IMAGES {
            if let Some((_, old)) = self.sent.pop() {
                self.out.extend(gfx::delete(old));
            }
        }
        id
    }
}

/// The selected tab's screenshot in the preview: image `id`, `cols`×`rows`
/// cells, on the first `rows` lines, `pad` columns in.
pub struct PImg {
    pub id: u32,
    pub cols: u16,
    pub rows: u16,
    pub pad: u16,
}

#[derive(Default)]
pub struct Layout {
    pub list: Rect,
    /// None when the screen is too narrow for it.
    pub preview: Option<Rect>,
    pub status: Rect,
}

pub struct App {
    host: Host,
    pub pal: Palette,
    pub snap: Snap,
    /// Tabs shown, as indices into `snap.tabs`, in order; and the title
    /// characters the filter matched, per shown tab.
    pub view: Vec<usize>,
    pub hits: Vec<Vec<usize>>,
    pub rows: Vec<Row>,
    /// The selected tab's place in `view`.
    pub cur: usize,
    /// The first row the list shows.
    pub list_top: usize,
    pub sort: Sort,
    pub mode: Mode,
    pub filter: String,
    /// A vim count being typed (5j, 12G).
    pub count: Option<u32>,
    pub msg: Option<(String, Instant)>,
    pub lay: Layout,
    /// The latest peek per tab, so going back to a tab shows it at once.
    peeks: HashMap<i64, Peek>,
    /// The selected tab's preview when it isn't a Kitty image: half blocks, or
    /// a line saying why there's no screenshot.
    pub plines: Vec<Line>,
    plines_key: Option<(i64, u64, u16)>,
    asked: Option<(i64, u16, u16, Instant)>,
    peek_tx: Sender<PeekReq>,
    peek_rx: Receiver<Peek>,
    msg_tx: Sender<String>,
    msg_rx: Receiver<String>,
    /// Tabs `x` closed: hidden even if Chrome lists them for a moment more.
    closed: HashSet<i64>,
    fetched: Instant,
    last_click: Option<(Instant, usize)>,
    /// False for --snapshot: nothing is focused, closed or copied.
    pub live: bool,
    /// Set when the terminal draws Kitty images: screenshots are real pictures.
    pub gfx: Option<Gfx>,
    imgs: Images,
    pub pimg: Option<PImg>,
}

impl App {
    pub fn new(host: Host, pal: Palette) -> Result<App, String> {
        let snap = bridge::list(&host)?;
        let (peek_tx, peek_rx) = bridge::peek_worker(host.clone());
        let (msg_tx, msg_rx) = mpsc::channel();
        let mut app = App {
            host,
            pal,
            snap,
            view: Vec::new(),
            hits: Vec::new(),
            rows: Vec::new(),
            cur: 0,
            list_top: 0,
            sort: Sort::Strip,
            mode: Mode::Normal,
            filter: String::new(),
            count: None,
            msg: None,
            lay: Layout::default(),
            peeks: HashMap::new(),
            plines: Vec::new(),
            plines_key: None,
            asked: None,
            peek_tx,
            peek_rx,
            msg_tx,
            msg_rx,
            closed: HashSet::new(),
            fetched: Instant::now(),
            last_click: None,
            live: true,
            gfx: None,
            imgs: Images::default(),
            pimg: None,
        };
        // Start on the tab you were last looking at.
        let here = app.snap.tabs.iter().filter(|t| t.active).max_by(|a, b| a.last.total_cmp(&b.last)).map(|t| t.id);
        app.set_view(here);
        Ok(app)
    }

    pub fn browser(&self) -> &str {
        &self.host.browser
    }

    pub fn selected(&self) -> Option<&Tab> {
        self.view.get(self.cur).map(|&i| &self.snap.tabs[i])
    }

    pub fn flash(&mut self, m: impl Into<String>) {
        self.msg = Some((m.into(), Instant::now()));
    }

    /// Recompute what's shown (filter, sort), keeping the cursor on tab `keep`
    /// when it's still there and on the same row otherwise.
    fn set_view(&mut self, keep: Option<i64>) {
        let q: String = self.filter.trim().to_string();
        let mut v: Vec<(usize, i64, Vec<usize>)> = Vec::new();
        for (i, t) in self.snap.tabs.iter().enumerate() {
            if self.closed.contains(&t.id) {
                continue;
            }
            if q.is_empty() {
                v.push((i, 0, Vec::new()));
                continue;
            }
            // Title or URL, the title preferred: only its hits get marked.
            let by_title = fuzzy::score(&q, t.display_title());
            let by_url = fuzzy::score(&q, t.short_url()).map(|(s, _)| s - 8);
            match (by_title, by_url) {
                (Some((s, h)), u) if u.is_none_or(|u| s >= u) => v.push((i, s, h)),
                (_, Some(u)) => v.push((i, u, Vec::new())),
                _ => {}
            }
        }
        if !q.is_empty() {
            v.sort_by(|a, b| b.1.cmp(&a.1));
        } else if self.sort == Sort::Recent {
            let tabs = &self.snap.tabs;
            v.sort_by(|a, b| tabs[b.0].last.total_cmp(&tabs[a.0].last));
        }
        self.view = v.iter().map(|x| x.0).collect();
        self.hits = v.into_iter().map(|x| x.2).collect();
        let at = keep.and_then(|id| self.view.iter().position(|&i| self.snap.tabs[i].id == id));
        self.cur = at.unwrap_or(self.cur).min(self.view.len().saturating_sub(1));
    }

    /// Re-read the tabs from the browser.
    fn refresh(&mut self) {
        self.fetched = Instant::now();
        match bridge::list(&self.host) {
            Ok(s) => {
                let keep = self.selected().map(|t| t.id);
                self.snap = s;
                let live: HashSet<i64> = self.snap.tabs.iter().map(|t| t.id).collect();
                self.closed.retain(|id| live.contains(id));
                self.peeks.retain(|id, _| live.contains(id));
                self.set_view(keep);
            }
            Err(e) => self.flash(e),
        }
    }

    // ---- layout ------------------------------------------------------------

    pub fn layout_for(&mut self, area: Rect) {
        let status = Rect::new(area.x, area.bottom().saturating_sub(1), area.width, area.height.min(1));
        let body = Rect::new(area.x, area.y, area.width, area.height.saturating_sub(1));
        self.lay = if body.width >= 72 && body.height >= 6 {
            let lw = (body.width * 2 / 5).clamp(36, 76);
            Layout {
                list: Rect::new(body.x, body.y, lw, body.height),
                preview: Some(Rect::new(body.x + lw, body.y, body.width - lw, body.height)),
                status,
            }
        } else if body.height >= 20 {
            // A narrow, tall pane: the preview goes under the list.
            let lh = (body.height * 2 / 5).max(6);
            Layout {
                list: Rect::new(body.x, body.y, body.width, lh),
                preview: Some(Rect::new(body.x, body.y + lh, body.width, body.height - lh)),
                status,
            }
        } else {
            Layout { list: body, preview: None, status }
        };
    }

    /// Rows inside the list's border.
    pub fn list_height(&self) -> usize {
        self.lay.list.height.saturating_sub(2) as usize
    }

    /// The preview's text area inside its border and padding: (rows, columns).
    pub fn preview_size(&self) -> (usize, u16) {
        self.lay.preview.map_or((1, 10), |r| ((r.height as usize).saturating_sub(2).max(1), r.width.saturating_sub(4).max(10)))
    }

    /// The box a thumbnail fits in, in pixels: the whole panel. Real pixels
    /// when the terminal draws images; otherwise one a column and two a row,
    /// for half blocks.
    fn thumb_box(&self) -> (u16, u16) {
        let (h, w) = self.preview_size();
        let rows = h as u16;
        match self.gfx {
            Some(g) => (w.saturating_mul(g.cell_w), rows.saturating_mul(g.cell_h)),
            None => (w, rows * 2),
        }
    }

    /// Bytes for the terminal (images to send or free), to write before drawing.
    pub fn take_gfx(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.imgs.out)
    }

    /// Free every image ctab sent, for quitting.
    pub fn clear_images(&mut self) -> Vec<u8> {
        for (_, id) in self.imgs.sent.drain(..) {
            self.imgs.out.extend(gfx::delete(id));
        }
        self.take_gfx()
    }

    // ---- per frame ---------------------------------------------------------

    /// Answers from the browser and timers. Returns true when a redraw is needed.
    pub fn tick(&mut self) -> bool {
        let mut dirty = false;
        while let Ok(mut p) = self.peek_rx.try_recv() {
            // "Same": the picture ctab has is still the latest (just re-taken), so keep it.
            if let Some((at, rev, fit)) = p.thumb.as_ref().filter(|t| matches!(t.px, Pixels::Same)).map(|t| (t.at, t.rev, t.fit)) {
                let old = self.peeks.remove(&p.tab).and_then(|o| o.thumb);
                p.thumb = old.filter(|o| o.rev == rev && o.fit == fit && !matches!(o.px, Pixels::Same)).map(|o| Thumb { at, ..o });
            }
            self.peeks.insert(p.tab, p);
            self.prune_peeks();
            dirty = true;
        }
        while let Ok(m) = self.msg_rx.try_recv() {
            self.flash(m);
            dirty = true;
        }
        if self.msg.as_ref().is_some_and(|(_, at)| at.elapsed() > FLASH) {
            self.msg = None;
            dirty = true;
        }
        if self.live && self.fetched.elapsed() > LIST_REFRESH {
            self.refresh();
            dirty = true;
        }
        self.request_peek();
        dirty
    }

    /// Ask for the selected tab's screenshot when it changes, the
    /// panel resizes, or the last answer is getting old.
    fn request_peek(&mut self) {
        if self.lay.preview.is_none() {
            return;
        }
        let Some(id) = self.selected().map(|t| t.id) else { return };
        let (w, h) = self.thumb_box();
        let stale = match self.asked {
            Some((t, aw, ah, at)) => t != id || aw != w || ah != h || (self.live && at.elapsed() > PEEK_REFRESH),
            None => true,
        };
        if stale {
            let png = self.gfx.is_some();
            let have = if png {
                self.peeks.get(&id).and_then(|p| p.thumb.as_ref()).filter(|t| t.fit == (w, h) && matches!(t.px, Pixels::Png(_))).map(|t| t.rev)
            } else {
                None
            };
            let _ = self.peek_tx.send(PeekReq { tab: id, w, h, png, have });
            self.asked = Some((id, w, h, Instant::now()));
        }
    }

    /// Forget the oldest peeks past KEEP_PEEKS (each can hold a PNG), never the selected tab's.
    fn prune_peeks(&mut self) {
        let sel = self.selected().map(|t| t.id);
        while self.peeks.len() > KEEP_PEEKS {
            let Some(old) = self.peeks.values().filter(|p| Some(p.tab) != sel).min_by_key(|p| p.seq).map(|p| p.tab) else {
                break;
            };
            self.peeks.remove(&old);
        }
    }

    /// Wait for the selected tab's first peek (--snapshot has no event loop).
    pub fn await_peek(&mut self, timeout: Duration) {
        self.request_peek();
        if let Ok(p) = self.peek_rx.recv_timeout(timeout) {
            self.peeks.insert(p.tab, p);
        }
    }

    /// Before drawing: the list's rows and scroll, and the preview's lines.
    pub fn prepare(&mut self) {
        self.build_rows();
        let h = self.list_height().max(1);
        let row = self.rows.iter().position(|r| matches!(r, Row::Tab(k) if *k == self.cur)).unwrap_or(0);
        // Keep the headings above the cursor's tab in view with it.
        let mut head = row;
        while head > 0 && matches!(self.rows[head - 1], Row::Header(..)) {
            head -= 1;
        }
        if head < self.list_top {
            self.list_top = head;
        }
        if row >= self.list_top + h {
            self.list_top = row + 1 - h;
        }
        self.list_top = self.list_top.min(self.rows.len().saturating_sub(h));
        self.build_preview();
    }

    /// Window and group headings go between tabs in strip order; a filtered
    /// or recent-first list is flat.
    fn build_rows(&mut self) {
        self.rows.clear();
        let headings = self.filter.trim().is_empty() && self.sort == Sort::Strip;
        let many_windows = self.snap.windows.len() > 1;
        let mut prev: Option<(i64, i64)> = None;
        for (k, &i) in self.view.iter().enumerate() {
            let t = &self.snap.tabs[i];
            if headings {
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
            }
            prev = Some((t.window, t.group));
            self.rows.push(Row::Tab(k));
        }
    }

    /// The selected tab's preview: its screenshot filling the panel (a picture
    /// when the terminal draws images, half blocks otherwise), or a line saying
    /// why there isn't one.
    fn build_preview(&mut self) {
        let Some(tid) = self.selected().map(|t| t.id) else {
            self.plines.clear();
            self.plines_key = None;
            self.pimg = None;
            return;
        };
        let w = self.preview_size().1;
        let key = (tid, self.peeks.get(&tid).map_or(0, |p| p.seq), w);
        if self.plines_key == Some(key) {
            return;
        }
        let width = w as usize;
        let mut out: Vec<Line> = Vec::new();
        self.pimg = None;
        let peek = self.peeks.get(&tid);
        let thumb = peek.and_then(|p| p.thumb.as_ref());
        match (thumb.map(|th| (th, &th.px)), self.gfx) {
            (Some((th, Pixels::Png(png))), Some(g)) => {
                let (cols, rows) = fit_cells(th, g, w);
                let id = self.imgs.id_for(ImgKey { tab: tid, rev: th.rev, fit: th.fit, cols, rows }, png);
                self.pimg = Some(PImg { id, cols, rows, pad: (w - cols) / 2 });
            }
            // An extension from before images answers a big box in RGB: no half blocks of that.
            (Some((th, Pixels::Rgb(rgb))), _) if th.w <= width => out.extend(thumb_lines(th, rgb, width)),
            _ => {
                let why = match peek {
                    None => "taking a look…".to_string(),
                    Some(pk) => pk.error.clone().unwrap_or_else(|| "no screenshot yet (one's taken when the tab is on screen)".to_string()),
                };
                let st = Style::new().fg(self.pal.dim);
                out.extend(wrap(&why, width).into_iter().map(|l| vec![(l, st)]));
            }
        }
        self.plines = out;
        self.plines_key = Some(key);
    }

    // ---- input -------------------------------------------------------------

    pub fn handle(&mut self, ev: Event) -> Act {
        match ev {
            Event::Key(k) if k.kind != KeyEventKind::Release => self.key(k),
            Event::Mouse(m) => self.mouse(m),
            _ => Act::None,
        }
    }

    fn key(&mut self, k: KeyEvent) -> Act {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && k.code == KeyCode::Char('c') {
            return Act::Quit;
        }
        match self.mode {
            Mode::Help => {
                self.mode = Mode::Normal;
                Act::None
            }
            Mode::Filter => self.key_filter(k, ctrl),
            Mode::Normal => self.key_normal(k, ctrl),
        }
    }

    fn key_normal(&mut self, k: KeyEvent, ctrl: bool) -> Act {
        if self.count_digit(&k) {
            return Act::None;
        }
        let count = self.count.take();
        let n = count.unwrap_or(1).max(1) as isize;
        let half = (self.list_height() as isize / 2).max(1);
        match k.code {
            // Esc drops a half-typed count, then a filter, before it quits.
            KeyCode::Esc if count.is_some() => {}
            KeyCode::Esc if !self.filter.is_empty() => self.set_filter(String::new()),
            KeyCode::Esc | KeyCode::Char('q') => return Act::Quit,
            KeyCode::Char('d') if ctrl => self.move_by(half),
            KeyCode::Char('u') if ctrl => self.move_by(-half),
            KeyCode::Char('n') if ctrl => self.move_by(n),
            KeyCode::Char('p') if ctrl => self.move_by(-n),
            KeyCode::Char('j') | KeyCode::Down => self.move_by(n),
            KeyCode::Char('k') | KeyCode::Up => self.move_by(-n),
            KeyCode::Char('g' | 'G') | KeyCode::Home | KeyCode::End if count.is_some() => self.go_to(n as usize - 1),
            KeyCode::Char('g') | KeyCode::Home => self.move_by(isize::MIN),
            KeyCode::Char('G') | KeyCode::End => self.move_by(isize::MAX),
            // `;` closes too, so ;;; clears tabs from the home row.
            KeyCode::Char('x' | ';') => self.close_selected(),
            KeyCode::Enter => return self.go(true),
            KeyCode::Char('o') => return self.go(false),
            KeyCode::Char('/') => self.mode = Mode::Filter,
            KeyCode::Char('s') => {
                self.sort = if self.sort == Sort::Strip { Sort::Recent } else { Sort::Strip };
                let keep = self.selected().map(|t| t.id);
                self.set_view(keep);
                self.flash(if self.sort == Sort::Recent { "most recently used first" } else { "tab strip order" });
            }
            KeyCode::Char('y') => self.copy_url(),
            KeyCode::Char('r') => {
                self.refresh();
                self.asked = None;
            }
            KeyCode::Char('?') => self.mode = Mode::Help,
            _ => {}
        }
        Act::None
    }

    /// Typing the filter: the list narrows to the best matches as you type,
    /// ⏎ goes to the top one, Esc stops typing and keeps the filter (so j/k
    /// and x work on what's left; Esc again clears it).
    fn key_filter(&mut self, k: KeyEvent, ctrl: bool) -> Act {
        match k.code {
            KeyCode::Esc | KeyCode::Tab => self.mode = Mode::Normal,
            KeyCode::Enter => return self.go(true),
            KeyCode::Up => self.move_by(-1),
            KeyCode::Down => self.move_by(1),
            KeyCode::Char('p') if ctrl => self.move_by(-1),
            KeyCode::Char('n') if ctrl => self.move_by(1),
            KeyCode::Char('u') if ctrl => self.set_filter(String::new()),
            KeyCode::Char('w') if ctrl => {
                let t = self.filter.trim_end();
                let cut = t.rfind(' ').map_or(0, |i| i + 1);
                self.set_filter(t[..cut].to_string());
            }
            KeyCode::Backspace => {
                if self.filter.is_empty() {
                    self.mode = Mode::Normal;
                } else {
                    let mut f = self.filter.clone();
                    f.pop();
                    self.set_filter(f);
                }
            }
            KeyCode::Char(c) if !ctrl => {
                let f = format!("{}{c}", self.filter);
                self.set_filter(f);
            }
            _ => {}
        }
        Act::None
    }

    fn set_filter(&mut self, f: String) {
        let keep = if f.trim().is_empty() { self.selected().map(|t| t.id) } else { None };
        self.filter = f;
        // Narrowing puts the cursor on the best match; clearing keeps your tab.
        if keep.is_none() {
            self.cur = 0;
        }
        self.set_view(keep);
    }

    /// A digit of a vim count (5j, 12G). A leading 0 is its own key.
    fn count_digit(&mut self, k: &KeyEvent) -> bool {
        let KeyCode::Char(c @ '0'..='9') = k.code else { return false };
        if k.modifiers.contains(KeyModifiers::CONTROL) || (c == '0' && self.count.is_none()) {
            return false;
        }
        let d = c as u32 - '0' as u32;
        self.count = Some((self.count.unwrap_or(0) * 10 + d).min(99_999));
        true
    }

    fn move_by(&mut self, d: isize) {
        if self.view.is_empty() {
            return;
        }
        let n = (self.cur as isize).saturating_add(d).clamp(0, self.view.len() as isize - 1) as usize;
        self.cur = n;
    }

    /// Tab `n` (0-based) in the list, as 12G.
    fn go_to(&mut self, n: usize) {
        self.move_by(n as isize - self.cur as isize);
    }

    /// ⏎ / o: bring the tab and the browser to the front; ⏎ also quits.
    fn go(&mut self, quit: bool) -> Act {
        let Some(t) = self.selected() else { return Act::None };
        let (id, name) = (t.id, t.display_title().to_string());
        if self.live {
            if let Err(e) = self.host.call("switcher.focus", json!({ "tab": id }), Duration::from_secs(2)) {
                self.flash(e);
                return Act::None;
            }
            self.host.activate();
        }
        if quit {
            return Act::Quit;
        }
        self.flash(format!("showing {name}"));
        Act::None
    }

    /// x / ;: close the selected tab now, no questions.
    fn close_selected(&mut self) {
        let Some(t) = self.selected() else { return };
        let (id, name) = (t.id, t.display_title().to_string());
        self.closed.insert(id);
        // The cursor stays on its row, which is now the next tab.
        self.set_view(None);
        if self.live {
            let host = self.host.clone();
            let tx = self.msg_tx.clone();
            std::thread::spawn(move || {
                let msg = match host.call("switcher.close", json!({ "tabs": [id] }), Duration::from_secs(3)) {
                    Ok(_) => format!("closed {name}"),
                    Err(e) => format!("couldn't close {name}: {e}"),
                };
                let _ = tx.send(msg);
            });
        }
    }

    fn copy_url(&mut self) {
        let Some(url) = self.selected().map(|t| t.url.clone()) else { return };
        if !self.live {
            return;
        }
        let ok = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .and_then(|mut c| {
                c.stdin.take().map(|mut s| s.write_all(url.as_bytes())).transpose()?;
                c.wait()
            })
            .is_ok_and(|s| s.success());
        self.flash(if ok { format!("copied {url}") } else { "couldn't copy (pbcopy)".to_string() });
    }

    fn mouse(&mut self, m: MouseEvent) -> Act {
        let inside = |r: Rect| m.column >= r.x && m.column < r.right() && m.row >= r.y && m.row < r.bottom();
        let in_list = inside(self.lay.list);
        match m.kind {
            MouseEventKind::ScrollDown if in_list => self.move_by(1),
            MouseEventKind::ScrollUp if in_list => self.move_by(-1),
            // Click a tab to select it; click it again quickly to go to it.
            MouseEventKind::Down(MouseButton::Left)
                if in_list && m.row > self.lay.list.y && m.row + 1 < self.lay.list.bottom() =>
            {
                let r = self.list_top + (m.row - self.lay.list.y - 1) as usize;
                if let Some(&Row::Tab(k)) = self.rows.get(r) {
                    let again = self.last_click.is_some_and(|(at, prev)| prev == k && at.elapsed() < MULTI_CLICK);
                    self.last_click = Some((Instant::now(), k));
                    self.go_to(k);
                    if again {
                        return self.go(true);
                    }
                }
            }
            _ => {}
        }
        Act::None
    }
}

// ---- the preview -------------------------------------------------------------

/// The cells a screenshot fills: as big as its box allows, keeping its shape,
/// and no wider than the preview's `width` columns.
fn fit_cells(th: &Thumb, g: Gfx, width: u16) -> (u16, u16) {
    let (bw, bh) = (f64::from(th.fit.0), f64::from(th.fit.1));
    let (w, h) = (th.w as f64, th.h as f64);
    let s = (bw / w).min(bh / h);
    let cols = (w * s / f64::from(g.cell_w)).round().max(1.0) as u16;
    let rows = (h * s / f64::from(g.cell_h)).round().max(1.0) as u16;
    (cols.min(width).min(gfx::MAX_CELLS), rows.min(gfx::MAX_CELLS))
}

/// A screenshot as half blocks: each cell is two pixels, ▀'s color on top and
/// the cell's background below. Centered in `width`.
fn thumb_lines(th: &Thumb, rgb: &[u8], width: usize) -> Vec<Line> {
    let tw = th.w.min(width);
    let pad = " ".repeat((width - tw) / 2);
    let px = |x: usize, y: usize| {
        let i = (y * th.w + x) * 3;
        Color::Rgb(rgb[i], rgb[i + 1], rgb[i + 2])
    };
    (0..th.h)
        .step_by(2)
        .map(|y| {
            let mut line: Line = vec![(pad.clone(), Style::new())];
            for x in 0..tw {
                let st = Style::new().fg(px(x, y));
                let st = if y + 1 < th.h { st.bg(px(x, y + 1)) } else { st };
                line.push(("▀".to_string(), st));
            }
            line
        })
        .collect()
}

/// Word-wrap one line to `w` columns; words longer than a line are broken.
fn wrap(s: &str, w: usize) -> Vec<String> {
    let w = w.max(1);
    let mut lines = Vec::new();
    let mut cur = String::new();
    let mut cw = 0;
    for word in s.split_inclusive(' ') {
        if cw > 0 && cw + word.trim_end().width() > w {
            lines.push(cur.trim_end().to_string());
            cur.clear();
            cw = 0;
        }
        if word.width() > w {
            for c in word.chars() {
                let x = c.width().unwrap_or(0);
                if cw + x > w {
                    lines.push(std::mem::take(&mut cur));
                    cw = 0;
                }
                cur.push(c);
                cw += x;
            }
        } else {
            cur.push_str(word);
            cw += word.width();
        }
    }
    if !cur.trim().is_empty() || lines.is_empty() {
        lines.push(cur.trim_end().to_string());
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::wrap;

    #[test]
    fn wraps_words() {
        assert_eq!(wrap("one two three", 7), ["one two", "three"]);
        assert_eq!(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
        assert_eq!(wrap("", 4), [""]);
    }
}
