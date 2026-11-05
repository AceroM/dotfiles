//! State and keys: jv's `;` dialog on its own. j/k with counts and relative
//! numbers, d/u through the preview (a Claude tab's transcript above its
//! screen), x or ; to close, c / r for the agent box, ⏎ to go. In the
//! preview, the mouse marks text to copy as in Codex (select.rs), and
//! ctrl-click opens a link (links.rs).

use std::collections::HashSet;
use std::ops::Range;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;
use ratatui::style::Style;

use crate::agent::{self, Field};
use crate::ansi::{self, Line};
use crate::fuzzy;
use crate::herdr::{self, Tab};
use crate::links::{self, Finder, Link};
use crate::select::{self, Sel, Spot, Wrap};
use crate::theme::Palette;
use crate::transcript::{self, Transcript};
use crate::ui;

/// The tabs and the preview are re-read this often.
const REFRESH: Duration = Duration::from_millis(700);
const MULTI_CLICK: Duration = Duration::from_millis(450);
/// Presses on one preview cell this close together count up: 2 marks a
/// word, 3 a line (Codex's timing).
const PRESS_REPEAT: Duration = Duration::from_millis(400);
const FLASH: Duration = Duration::from_secs(4);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Normal,
    /// Typing the `/` filter.
    Filter,
    /// The agent box: `c` for a new agent, `r` to reply to the selected tab's.
    Ask,
    Help,
}

pub enum Act {
    None,
    Quit,
}

#[derive(Default)]
pub struct Layout {
    pub screen: Rect,
    pub list: Rect,
    /// None when the screen is too small for it.
    pub preview: Option<Rect>,
    pub status: Rect,
}

/// An `r` reply's destination: the agent's pane, and its tab's name.
#[derive(Clone)]
pub struct ReplyTo {
    pub pane: String,
    pub label: String,
}

pub struct Opts {
    /// Where `c` starts its agent.
    pub cwd: PathBuf,
    /// What ^i / Tab puts in the agent box (jv passes the file it's on).
    pub path: Option<String>,
}

/// A finished close: its status line, and the tab to show again if it failed.
type Closed = (String, Option<String>);

pub struct App {
    pub pal: Palette,
    ws: String,
    me: String,
    /// The Herdr space's name.
    pub space: String,
    pub tabs: Vec<Tab>,
    /// Tabs shown, as indices into `tabs`, in order (the filter's best first).
    pub view: Vec<usize>,
    /// Per shown tab, the characters the filter matched: in its name, in its title.
    pub hits: Vec<(Vec<usize>, Vec<usize>)>,
    /// The selected tab's place in `view`.
    pub cur: usize,
    pub list_top: usize,
    /// The tab the preview shows.
    preview_of: Option<String>,
    /// Its focused pane's latest lines, ending with its screen.
    pub preview: Vec<Line>,
    /// Rows the preview is scrolled up from the bottom (`u` / `d`).
    pub scroll: usize,
    /// A Claude tab scrolled past the top of its screen shows its transcript.
    pub transcript: Option<Transcript>,
    pub in_transcript: bool,
    fetched: Instant,
    pub mode: Mode,
    pub filter: String,
    /// A vim count being typed (5j, 12G).
    pub count: Option<usize>,
    pub msg: Option<(String, Instant)>,
    pub lay: Layout,
    /// Tabs `x` closed: hidden even if Herdr still lists them for a moment.
    closed: HashSet<String>,
    closed_tx: Sender<Closed>,
    closed_rx: Receiver<Closed>,
    /// The agent box's draft, kept across Esc until it's sent.
    pub ask: Field,
    /// Files behind the draft's `[Image #N]` tags (N - 1 indexes this).
    ask_images: Vec<PathBuf>,
    /// Who the box sends to: None starts an agent in a new tab (`c`), Some
    /// replies to one already running (`r`).
    pub reply_to: Option<ReplyTo>,
    /// The other box's draft (a reply's while `c` is up, and the other way
    /// round), swapped back in when it opens again.
    parked: (Field, Vec<PathBuf>),
    pub ask_path: Option<String>,
    /// The agent kind `c` starts.
    pub ask_kind: String,
    pub ask_cwd: PathBuf,
    bg_tx: Sender<String>,
    bg_rx: Receiver<String>,
    last_click: Option<(Instant, usize)>,
    /// Text marked in the preview: a drag, a double-click's word, a
    /// triple-click's line. While there's a mark the preview holds still, as
    /// Codex's transcript stops following: ^c copies, ⏎ copies and follows.
    pub sel: Option<Sel>,
    /// Where the left button went down in the preview: a drag marks from here.
    press: Option<Spot>,
    /// The preview's last press: when, where, and how many in a row.
    last_press: Option<(Instant, u16, u16, u8)>,
    /// The links on the preview's visible lines.
    pub links: Vec<Link>,
    finder: Finder,
    /// False for --snapshot: nothing is focused, closed or sent.
    pub live: bool,
    /// What the agent box would have sent (--snapshot).
    pub sent: Option<String>,
    /// What would have gone on the clipboard, and the link that would have opened (--snapshot).
    pub copied: Option<String>,
    pub opened: Option<String>,
}

impl App {
    pub fn new(pal: Palette, opts: Opts) -> Result<App, String> {
        let ws = std::env::var("HERDR_WORKSPACE_ID").map_err(|_| "no HERDR_WORKSPACE_ID: not in a Herdr pane".to_string())?;
        let me = std::env::var("HERDR_TAB_ID").unwrap_or_default();
        let (space, tabs) = herdr::tabs(&ws, &me)?;
        let (bg_tx, bg_rx) = mpsc::channel();
        let (closed_tx, closed_rx) = mpsc::channel();
        let mut app = App {
            pal,
            ws,
            me,
            space,
            tabs,
            view: Vec::new(),
            hits: Vec::new(),
            cur: 0,
            list_top: 0,
            preview_of: None,
            preview: Vec::new(),
            scroll: 0,
            transcript: None,
            in_transcript: false,
            fetched: Instant::now(),
            mode: Mode::Normal,
            filter: String::new(),
            count: None,
            msg: None,
            lay: Layout::default(),
            closed: HashSet::new(),
            closed_tx,
            closed_rx,
            ask: Field::default(),
            ask_images: Vec::new(),
            reply_to: None,
            parked: (Field::default(), Vec::new()),
            ask_path: opts.path,
            ask_kind: agent::spec().0,
            ask_cwd: opts.cwd,
            bg_tx,
            bg_rx,
            last_click: None,
            sel: None,
            press: None,
            last_press: None,
            links: Vec::new(),
            finder: Finder::default(),
            live: true,
            sent: None,
            copied: None,
            opened: None,
        };
        app.set_view(None);
        Ok(app)
    }

    pub fn selected(&self) -> Option<&Tab> {
        self.view.get(self.cur).map(|&i| &self.tabs[i])
    }

    pub fn flash(&mut self, m: impl Into<String>) {
        self.msg = Some((m.into(), Instant::now()));
    }

    /// Recompute what's shown (the filter), keeping the cursor on tab `keep`
    /// when it's still there and on the same row otherwise.
    fn set_view(&mut self, keep: Option<String>) {
        let q = self.filter.trim().to_string();
        let mut v: Vec<(usize, i64, (Vec<usize>, Vec<usize>))> = Vec::new();
        for (i, t) in self.tabs.iter().enumerate() {
            if q.is_empty() {
                v.push((i, 0, Default::default()));
                continue;
            }
            // The name, the title, the folder, in that order of preference:
            // the name's and the title's hits get marked.
            let name = fuzzy::score(&q, t.name());
            let title = fuzzy::score(&q, &t.title).map(|(s, h)| (s - 8, h));
            let cwd = fuzzy::score(&q, &herdr::tilde(&t.cwd)).map(|(s, _)| s - 16);
            let best = [name.as_ref().map(|x| x.0), title.as_ref().map(|x| x.0), cwd].into_iter().flatten().max();
            let Some(best) = best else { continue };
            let hits = match (name, title) {
                (Some((s, h)), _) if s == best => (h, Vec::new()),
                (_, Some((s, h))) if s == best => (Vec::new(), h),
                _ => Default::default(),
            };
            v.push((i, best, hits));
        }
        if !q.is_empty() {
            v.sort_by(|a, b| b.1.cmp(&a.1));
        }
        self.view = v.iter().map(|x| x.0).collect();
        self.hits = v.into_iter().map(|x| x.2).collect();
        let at = keep.and_then(|id| self.view.iter().position(|&i| self.tabs[i].id == id));
        self.cur = at.unwrap_or(self.cur).min(self.view.len().saturating_sub(1));
    }

    /// Re-read the tabs (the cursor stays on its tab) and the preview.
    fn refresh(&mut self) {
        self.fetched = Instant::now();
        match herdr::tabs(&self.ws, &self.me) {
            Ok((space, mut list)) => {
                let live: HashSet<&str> = list.iter().map(|t| t.id.as_str()).collect();
                self.closed.retain(|id| live.contains(id.as_str()));
                list.retain(|t| !self.closed.contains(&t.id));
                let keep = self.selected().map(|t| t.id.clone());
                self.space = space;
                self.tabs = list;
                self.set_view(keep);
            }
            // A hiccup keeps what's on screen.
            Err(e) => self.flash(e),
        }
        if !self.holding() {
            self.load_preview();
        }
    }

    // ---- layout ------------------------------------------------------------

    pub fn layout_for(&mut self, area: Rect) {
        let status = Rect::new(area.x, area.bottom().saturating_sub(1), area.width, area.height.min(1));
        let body = Rect::new(area.x, area.y, area.width, area.height.saturating_sub(1));
        let (list, preview) = if body.width >= 60 && body.height >= 4 {
            let lw = (body.width * 3 / 10).clamp(28, 56);
            (Rect::new(body.x, body.y, lw, body.height), Some(Rect::new(body.x + lw, body.y, body.width - lw, body.height)))
        } else if body.height >= 20 {
            // A narrow, tall pane: the preview goes under the list.
            let lh = (body.height * 2 / 5).max(6);
            (Rect::new(body.x, body.y, body.width, lh), Some(Rect::new(body.x, body.y + lh, body.width, body.height - lh)))
        } else {
            (body, None)
        };
        self.lay = Layout { screen: area, list, preview, status };
    }

    /// Rows inside the list's border.
    pub fn list_height(&self) -> usize {
        self.lay.list.height.saturating_sub(2) as usize
    }

    /// The preview's text area inside its border and padding: (rows, columns).
    pub fn preview_size(&self) -> (usize, usize) {
        self.lay
            .preview
            .map_or((1, 10), |r| ((r.height as usize).saturating_sub(2).max(1), (r.width as usize).saturating_sub(4).max(10)))
    }

    // ---- per frame ---------------------------------------------------------

    /// Answers from background jobs, the live refresh, timers. Returns true
    /// when a redraw is needed.
    pub fn tick(&mut self) -> bool {
        let mut dirty = false;
        while let Ok(m) = self.bg_rx.try_recv() {
            self.flash(m);
            dirty = true;
        }
        while let Ok((m, failed)) = self.closed_rx.try_recv() {
            if let Some(id) = failed {
                self.closed.remove(&id);
                self.fetched = Instant::now() - REFRESH * 2;
            }
            self.flash(m);
            dirty = true;
        }
        if self.msg.as_ref().is_some_and(|(_, at)| at.elapsed() > FLASH) {
            self.msg = None;
            dirty = true;
        }
        if self.live && self.fetched.elapsed() > REFRESH {
            self.refresh();
            dirty = true;
        }
        dirty
    }

    /// Before drawing: the preview of the selected tab, and the list's scroll.
    pub fn prepare(&mut self) {
        let id = self.selected().map(|t| t.id.clone());
        if id != self.preview_of {
            self.preview_of = id;
            self.reset_preview();
            self.load_preview();
        }
        let h = self.list_height().max(1);
        if self.cur < self.list_top {
            self.list_top = self.cur;
        }
        if self.cur >= self.list_top + h {
            self.list_top = self.cur + 1 - h;
        }
        self.list_top = self.list_top.min(self.view.len().saturating_sub(h));
        self.find_links();
    }

    /// The links on the preview's visible lines, paths found in the
    /// previewed tab's folder.
    fn find_links(&mut self) {
        let cwd = match self.selected() {
            Some(t) if self.lay.preview.is_some() => PathBuf::from(&t.cwd),
            _ => {
                self.links.clear();
                return;
            }
        };
        self.finder.set_cwd(&cwd);
        let w = self.window(self.preview_size().0);
        let texts: Vec<(usize, String)> = w.map(|i| (i, select::plain(&self.lines()[i]))).collect();
        let mut links = Vec::new();
        for (i, s) in texts {
            self.finder.find(i, &s, &mut links);
        }
        self.links = links;
    }

    // ---- the preview -------------------------------------------------------

    /// Another tab is selected: back to its live screen, unscrolled.
    fn reset_preview(&mut self) {
        self.clear_sel();
        self.scroll = 0;
        self.transcript = None;
        self.in_transcript = false;
    }

    fn load_preview(&mut self) {
        let w = self.preview_size().1;
        let pane = self.selected().and_then(|t| t.pane.clone());
        self.preview = match pane {
            Some(p) => herdr::read(&p).map_or_else(|e| vec![vec![(e, Style::new())]], |t| ansi::parse(&t)),
            None => Vec::new(),
        };
        if let Some(t) = self.transcript.as_mut() {
            t.set_width(w);
            // New turns land at the bottom; a view scrolled up keeps its place.
            let before = t.lines.len();
            if t.grow() && self.in_transcript && self.scroll > 0 {
                self.scroll += t.lines.len() - before;
            }
        }
    }

    /// What the preview shows: the pane's lines, or the transcript's.
    pub fn lines(&self) -> &[Line] {
        match &self.transcript {
            Some(t) if self.in_transcript => &t.lines,
            _ => &self.preview,
        }
    }

    /// The preview lines shown in `h` rows: bottom-aligned, less the scroll.
    /// Trailing blank lines don't count as content.
    pub fn window(&self, h: usize) -> Range<usize> {
        let blank = |l: &Line| l.iter().all(|(s, _)| s.trim().is_empty());
        let end = self.lines().iter().rposition(|l| !blank(l)).map_or(0, |i| i + 1);
        let e = end - self.scroll.min(end.saturating_sub(h));
        e.saturating_sub(h)..e
    }

    /// How far up the preview can scroll in `h` rows.
    fn max_scroll(&self, h: usize) -> usize {
        let w = self.window(usize::MAX);
        (w.end - w.start).saturating_sub(h)
    }

    fn transcript_colors(&self) -> transcript::Colors {
        let p = &self.pal;
        transcript::Colors { fg: p.fg, bright: p.bright, dim: p.dim, accent: p.accent, green: p.green }
    }

    /// `u` / `d`: scroll the preview up (positive) or back down. A Claude
    /// tab carries on up past its screen into its transcript, which reads
    /// further back as you go; coming back down past the transcript's end
    /// returns to the live screen.
    /// A mark holds the preview to what it was marked in: no crossing
    /// between the screen and the transcript, and lines the transcript loads
    /// above move the mark down with them.
    fn preview_scroll(&mut self, d: isize) {
        let (h, w) = self.preview_size();
        let hold = self.holding();
        let want = (self.scroll as isize).saturating_add(d).max(0) as usize;
        if d > 0 && !hold && !self.in_transcript && self.scroll >= self.max_scroll(h) {
            if self.transcript.is_none() {
                let colors = self.transcript_colors();
                let path = self.selected().and_then(|t| t.claude_session.as_deref()).and_then(transcript::find);
                self.transcript = path.and_then(|p| Transcript::open(p, w, colors));
            }
            if let Some(t) = self.transcript.as_mut() {
                // The newest chunk can be mostly tool output: read on until the panel fills.
                while t.lines.len() < h && t.load_earlier() {}
                self.in_transcript = true;
                self.scroll = 0;
                return;
            }
        }
        if d < 0 && !hold && self.in_transcript && self.scroll == 0 {
            // Below the transcript's end is the screen, from its top.
            self.in_transcript = false;
            self.scroll = self.max_scroll(h);
            return;
        }
        if self.in_transcript {
            if let Some(t) = self.transcript.as_mut() {
                let before = t.lines.len();
                while want + h > t.lines.len() && t.load_earlier() {}
                let added = t.lines.len() - before;
                if added > 0 {
                    self.sel = self.sel.map(|s| s.shifted(added));
                    self.press = self.press.map(|p| Spot { line: p.line + added, ..p });
                }
            }
        }
        self.scroll = want.min(self.max_scroll(h));
    }

    // ---- marking and copying -----------------------------------------------

    /// While text is marked, or being marked, the preview isn't re-read under it.
    fn holding(&self) -> bool {
        self.sel.is_some() || self.press.is_some()
    }

    fn clear_sel(&mut self) {
        self.sel = None;
        self.press = None;
    }

    /// The preview's text cells: inside its border, a column of padding each side.
    pub fn preview_text(&self) -> Option<Rect> {
        let r = self.lay.preview?;
        (r.width > 4 && r.height > 2).then(|| Rect::new(r.x + 2, r.y + 1, r.width - 4, r.height - 2))
    }

    /// The caret place at screen cell (x, y), kept inside the preview's text:
    /// above it is its top row, below its last line that line's end, past its
    /// right edge the rest of the line.
    fn spot_at(&self, x: u16, y: u16) -> Option<Spot> {
        let t = self.preview_text()?;
        let w = self.window(t.height as usize);
        if w.is_empty() {
            return None;
        }
        let line = w.start + (y.clamp(t.y, t.bottom() - 1) - t.y) as usize;
        if line >= w.end {
            return Some(Spot { line: w.end - 1, col: select::EOL });
        }
        let col = if x >= t.right() { select::EOL } else { x.saturating_sub(t.x) as usize };
        Some(Spot { line, col })
    }

    /// A press in the preview: the start of a drag, or the second or third
    /// on one cell, a word or a line.
    fn press_at(&mut self, x: u16, y: u16) {
        let n = match self.last_press {
            Some((at, px, py, n)) if at.elapsed() < PRESS_REPEAT && (px, py) == (x, y) => n % 3 + 1,
            _ => 1,
        };
        self.last_press = Some((Instant::now(), x, y, n));
        self.clear_sel();
        let Some(s) = self.spot_at(x, y) else { return };
        match n {
            1 => self.press = Some(s),
            2 => self.sel = select::word(&self.lines()[s.line], s.line, s.col),
            _ => self.sel = Some(Sel::line(s.line)),
        }
    }

    /// Dragging: the mark runs from the press to here. Past the preview's
    /// top or bottom it scrolls along, a row a move.
    fn drag_to(&mut self, x: u16, y: u16) {
        let Some(t) = self.preview_text() else { return };
        if y < t.y {
            self.preview_scroll(1);
        } else if y >= t.bottom() {
            self.preview_scroll(-1);
        }
        let (Some(anchor), Some(head)) = (self.press, self.spot_at(x, y)) else { return };
        self.sel = (anchor != head).then_some(Sel { anchor, head });
    }

    /// ^c, y or a right-click: the mark onto the clipboard, and the preview
    /// moving again. ⏎ (`follow`) also takes it back down to the live screen.
    fn copy_sel(&mut self, follow: bool) {
        let Some(sel) = self.sel else { return };
        let wraps: &[Option<Wrap>] = match &self.transcript {
            Some(t) if self.in_transcript => &t.wraps,
            _ => &[],
        };
        let text = select::text(self.lines(), wraps, &sel);
        self.clear_sel();
        // Only spaces marked: nothing to put on the clipboard.
        if text.is_empty() {
            return;
        }
        let n = text.chars().count();
        let done = format!("copied {n} char{}", if n == 1 { "" } else { "s" });
        if !self.live {
            self.copied = Some(text);
            self.flash(done);
        } else {
            match select::copy(&text) {
                Ok(()) => self.flash(done),
                Err(e) => self.flash(format!("couldn't copy: {e}")),
            }
        }
        if follow {
            self.reset_preview();
        }
        if self.live {
            self.load_preview();
        }
    }

    /// The link at screen cell (x, y) of the preview.
    fn link_at(&self, x: u16, y: u16) -> Option<&Link> {
        let t = self.preview_text()?;
        if !(t.x..t.right()).contains(&x) || !(t.y..t.bottom()).contains(&y) {
            return None;
        }
        let line = self.window(t.height as usize).start + (y - t.y) as usize;
        let col = (x - t.x) as usize;
        self.links.iter().find(|l| l.line == line && l.cols.contains(&col))
    }

    /// Ctrl- (or ⌘-) click on a link. Herdr opens the links it sees itself
    /// (al hands it each one's whole target: see main.rs), so this is one it
    /// passed on.
    fn open_link(&mut self, x: u16, y: u16) {
        let Some(t) = self.link_at(x, y).map(|l| l.target.clone()) else { return };
        if !self.live {
            self.opened = Some(t.uri());
            return;
        }
        let tx = self.bg_tx.clone();
        std::thread::spawn(move || {
            if let Err(e) = links::open(&t) {
                let _ = tx.send(format!("couldn't open it: {e}"));
            }
        });
    }

    /// The links' visible cells as screen runs (x, y, width, target), for
    /// main.rs to make hyperlinks of. None while a box covers the preview.
    pub fn link_runs(&self) -> Vec<(u16, u16, u16, String)> {
        let Some(t) = self.preview_text() else { return Vec::new() };
        if matches!(self.mode, Mode::Help | Mode::Ask) {
            return Vec::new();
        }
        let top = self.window(t.height as usize).start;
        self.links
            .iter()
            .filter_map(|l| {
                let y = t.y + u16::try_from(l.line.checked_sub(top)?).ok()?;
                let x = t.x as usize + l.cols.start;
                let end = (t.x as usize + l.cols.end).min(t.right() as usize);
                (y < t.bottom() && x < end).then(|| (x as u16, y, (end - x) as u16, l.target.uri()))
            })
            .collect()
    }

    // ---- input -------------------------------------------------------------

    pub fn handle(&mut self, ev: Event) -> Act {
        match ev {
            Event::Key(k) if k.kind != KeyEventKind::Release => self.key(k),
            Event::Paste(s) => {
                self.paste(&s);
                Act::None
            }
            Event::Mouse(m) => self.mouse(m),
            _ => Act::None,
        }
    }

    fn key(&mut self, k: KeyEvent) -> Act {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        match self.mode {
            Mode::Help => {
                self.mode = Mode::Normal;
                Act::None
            }
            Mode::Ask => {
                self.key_ask(k);
                Act::None
            }
            Mode::Filter => self.key_filter(k, ctrl),
            Mode::Normal => self.key_normal(k, ctrl),
        }
    }

    fn key_normal(&mut self, k: KeyEvent, ctrl: bool) -> Act {
        // Text marked in the preview: ^c (or ⌘c, or y) copies it, ⏎ copies
        // and follows the pane again, esc clears it. Codex's keys.
        if self.sel.is_some() && self.count.is_none() {
            let copy_mods = k.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::SUPER);
            match k.code {
                KeyCode::Char('c' | 'C') if copy_mods => return self.then_none(|a| a.copy_sel(false)),
                KeyCode::Char('y') if !ctrl => return self.then_none(|a| a.copy_sel(false)),
                KeyCode::Enter => return self.then_none(|a| a.copy_sel(true)),
                KeyCode::Esc => return self.then_none(App::clear_sel),
                _ => {}
            }
        }
        // Counts as in jv's tree: 5j / 3k by the relative numbers, 12G to tab 12.
        if self.count_digit(&k) {
            return Act::None;
        }
        let count = self.count.take();
        let n = count.unwrap_or(1).max(1) as isize;
        let half = (self.list_height() as isize / 2).max(1);
        let phalf = (self.preview_size().0 as isize / 2).max(1);
        match k.code {
            // Esc drops a half-typed count, then a filter, before it quits.
            KeyCode::Esc if count.is_some() => {}
            KeyCode::Esc if !self.filter.is_empty() => self.set_filter(String::new()),
            KeyCode::Esc | KeyCode::Char('q') => return Act::Quit,
            KeyCode::Char('c') if ctrl => return Act::Quit,
            KeyCode::Char('d') if ctrl => self.move_by(half),
            KeyCode::Char('u') if ctrl => self.move_by(-half),
            KeyCode::Char('n') if ctrl => self.move_by(n),
            KeyCode::Char('p') if ctrl => self.move_by(-n),
            // d / u: the preview, half a panel at a time (as in jv's diff).
            KeyCode::Char('d') => self.preview_scroll(-phalf * n),
            KeyCode::Char('u') => self.preview_scroll(phalf * n),
            KeyCode::Char('j') | KeyCode::Down => self.move_by(n),
            KeyCode::Char('k') | KeyCode::Up => self.move_by(-n),
            KeyCode::Char('g' | 'G') | KeyCode::Home | KeyCode::End if count.is_some() => self.go_to(n as usize - 1),
            KeyCode::Char('g') | KeyCode::Home => self.move_by(isize::MIN),
            KeyCode::Char('G') | KeyCode::End => self.move_by(isize::MAX),
            // `;` closes too, so ;;; clears tabs from the home row.
            KeyCode::Char('x' | ';') => self.close_selected(),
            // The agent box: c for a new agent (its tab shows up in the
            // list), r to reply to the selected tab's.
            KeyCode::Char('c') => self.show_box(None),
            KeyCode::Char('r') => self.open_reply(),
            KeyCode::Enter => return self.go(true),
            KeyCode::Char('o') => return self.go(false),
            KeyCode::Char('/') => self.mode = Mode::Filter,
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
            KeyCode::Char('c') if ctrl => return Act::Quit,
            KeyCode::Esc | KeyCode::Tab => self.mode = Mode::Normal,
            KeyCode::Enter => return self.go(true),
            KeyCode::Up => self.move_by(-1),
            KeyCode::Down => self.move_by(1),
            KeyCode::Char('p') if ctrl => self.move_by(-1),
            KeyCode::Char('n') if ctrl => self.move_by(1),
            KeyCode::Char('u' | 'l') if ctrl => self.set_filter(String::new()),
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
        let keep = if f.trim().is_empty() { self.selected().map(|t| t.id.clone()) } else { None };
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
        let d = c as usize - '0' as usize;
        self.count = Some((self.count.unwrap_or(0) * 10 + d).min(99_999));
        true
    }

    fn then_none(&mut self, f: impl FnOnce(&mut App)) -> Act {
        f(self);
        Act::None
    }

    fn move_by(&mut self, d: isize) {
        if self.view.is_empty() {
            return;
        }
        self.cur = (self.cur as isize).saturating_add(d).clamp(0, self.view.len() as isize - 1) as usize;
    }

    /// Tab `n` (0-based) in the list, as 12G.
    fn go_to(&mut self, n: usize) {
        self.move_by(n as isize - self.cur as isize);
    }

    /// ⏎ / o: switch Herdr to the selected tab; ⏎ also quits.
    fn go(&mut self, quit: bool) -> Act {
        let Some(t) = self.selected() else { return Act::None };
        let (id, name) = (t.id.clone(), t.name().to_string());
        if self.live {
            if let Err(e) = herdr::focus_tab(&id) {
                self.flash(e);
                return Act::None;
            }
        }
        if quit {
            return Act::Quit;
        }
        self.flash(format!("showing {name}"));
        Act::None
    }

    /// x / ;: close the selected tab now, no questions, like ctrl+alt+x.
    fn close_selected(&mut self) {
        let Some(t) = self.selected() else { return };
        let (id, name) = (t.id.clone(), t.name().to_string());
        self.closed.insert(id.clone());
        self.tabs.retain(|t| t.id != id);
        // The cursor stays on its row, which is now the next tab.
        self.set_view(None);
        if self.live {
            let tx = self.closed_tx.clone();
            std::thread::spawn(move || {
                let msg = match herdr::close_tab(&id) {
                    Ok(()) => (format!("closed {name}"), None),
                    Err(e) => (format!("couldn't close {name}: {e}"), Some(id)),
                };
                let _ = tx.send(msg);
            });
        }
    }

    // ---- the agent box -----------------------------------------------------

    /// `r`: the box, aimed at the selected tab's agent.
    fn open_reply(&mut self) {
        let Some(t) = self.selected() else { return };
        let label = t.name().to_string();
        let Some(pane) = t.agent_pane.clone() else {
            self.flash(format!("no agent in {label} to reply to"));
            return;
        };
        self.show_box(Some(ReplyTo { pane, label }));
    }

    /// Open the agent box for `to`, with that kind of box's draft.
    fn show_box(&mut self, to: Option<ReplyTo>) {
        if self.reply_to.is_some() != to.is_some() {
            std::mem::swap(&mut self.ask, &mut self.parked.0);
            std::mem::swap(&mut self.ask_images, &mut self.parked.1);
        }
        self.reply_to = to;
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
        if let Some(to) = self.reply_to.clone() {
            self.flash(format!("replying to {}…", to.label));
            if self.live {
                agent::reply(to.pane, prompt, to.label, self.bg_tx.clone());
            } else {
                self.sent = Some(prompt);
            }
            return;
        }
        if self.live {
            agent::spawn(prompt, self.ask_cwd.clone(), self.bg_tx.clone());
        } else {
            self.sent = Some(prompt);
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
            // ^i: the --path file. Without the kitty protocol ^i is a Tab, so Tab does it too.
            KeyCode::Char('i') if ctrl => self.insert_ask_path(),
            KeyCode::Tab => self.insert_ask_path(),
            KeyCode::Char('v') if ctrl => self.paste_image(),
            // ^l: the whole draft, its images too.
            KeyCode::Char('l') if ctrl => {
                f.clear();
                self.ask_images.clear();
            }
            // ↑↓: a row up or down, as the box wraps the text.
            KeyCode::Up | KeyCode::Down => {
                let rows = ui::prompt_rows(&f.text, ui::ask_width(self.lay.screen.width));
                f.vertical(&rows, if k.code == KeyCode::Up { -1 } else { 1 });
            }
            _ => {
                f.key(&k);
            }
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

    /// Bracketed paste: whole into the agent box, the first line into the
    /// filter. In the agent box, image files dropped in become tags, and an
    /// empty paste (⌘V with only an image on the clipboard) takes the
    /// clipboard's image.
    fn paste(&mut self, s: &str) {
        let s = s.replace("\r\n", "\n").replace('\r', "\n").replace('\t', "    ");
        match self.mode {
            Mode::Ask if s.trim().is_empty() => self.paste_image(),
            Mode::Ask => match agent::image_paths(&s) {
                Some(files) => files.into_iter().for_each(|f| self.attach(f)),
                None => self.ask.insert(&s),
            },
            Mode::Filter => {
                let line: String = s.lines().next().unwrap_or("").chars().filter(|c| !c.is_control()).take(200).collect();
                let f = format!("{}{line}", self.filter);
                self.set_filter(f);
            }
            _ => {}
        }
    }

    // ---- mouse -------------------------------------------------------------

    fn mouse(&mut self, m: MouseEvent) -> Act {
        if self.mode != Mode::Normal {
            return Act::None;
        }
        let inside = |r: Rect| m.column >= r.x && m.column < r.right() && m.row >= r.y && m.row < r.bottom();
        let list = self.lay.list;
        let in_list = inside(list);
        let in_preview = self.lay.preview.is_some_and(inside);
        let in_text = self.preview_text().is_some_and(inside);
        let modded = m.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::SUPER);
        // A click anywhere but the preview's text clears its mark, as in Codex.
        if matches!(m.kind, MouseEventKind::Down(_)) && !in_text {
            self.clear_sel();
        }
        match m.kind {
            MouseEventKind::ScrollDown if in_list => self.move_by(1),
            MouseEventKind::ScrollUp if in_list => self.move_by(-1),
            MouseEventKind::ScrollDown if in_preview => self.preview_scroll(-3),
            MouseEventKind::ScrollUp if in_preview => self.preview_scroll(3),
            MouseEventKind::Down(MouseButton::Left) if in_text && modded => self.open_link(m.column, m.row),
            MouseEventKind::Down(MouseButton::Left) if in_text => self.press_at(m.column, m.row),
            MouseEventKind::Drag(MouseButton::Left) if self.press.is_some() => self.drag_to(m.column, m.row),
            // The button came up, maybe outside the pane: motion with none down says so too.
            MouseEventKind::Up(MouseButton::Left) | MouseEventKind::Moved => self.press = None,
            // Right-click copies the mark, as in Codex.
            MouseEventKind::Down(MouseButton::Right) if in_text => self.copy_sel(false),
            // Click a tab to select it; click it again quickly to go to it.
            MouseEventKind::Down(MouseButton::Left) if in_list && m.row > list.y && m.row + 1 < list.bottom() => {
                let k = self.list_top + (m.row - list.y - 1) as usize;
                if k < self.view.len() {
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
