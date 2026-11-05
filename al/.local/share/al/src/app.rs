//! State and keys: jv's `;` dialog on its own. j/k with counts and relative
//! numbers, J/K through the preview (a Claude tab's transcript above its
//! screen), x or ; to close, c / r for the agent box, ⏎ to go (al stays
//! open), y / Y to copy the tab's pane and session IDs. `d` drafts a prompt:
//! it waits on top of the tabs (drafts.rs) until ⏎ starts its agent. A draft
//! reads as a page in the preview, a centered column with its images
//! (gfx.rs), and `d` / `e` write it right there. In the preview, the mouse
//! marks text to copy as in Codex (select.rs), and ctrl-click opens a link
//! (links.rs).

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant, SystemTime};

use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;
use ratatui::style::Style;

use crate::agent::{self, Field};
use crate::ansi::{self, Line};
use crate::drafts::{self, Draft, Pic};
use crate::fuzzy;
use crate::gfx::{self, Gfx};
use crate::herdr::{self, Tab};
use crate::links::{self, Finder, Link};
use crate::select::{self, Sel, Spot, Wrap};
use crate::theme::Palette;
use crate::transcript::{self, Transcript};
use crate::ui;

use unicode_width::UnicodeWidthStr;

/// The tabs and the preview are re-read this often.
const REFRESH: Duration = Duration::from_millis(700);
const MULTI_CLICK: Duration = Duration::from_millis(450);
/// Presses on one preview cell this close together count up: 2 marks a
/// word, 3 a line (Codex's timing).
const PRESS_REPEAT: Duration = Duration::from_millis(400);
const FLASH: Duration = Duration::from_secs(4);
const TOAST: Duration = Duration::from_millis(2500);
/// Draft images kept in the terminal, for going back to a draft.
const KEEP_IMAGES: usize = 16;
/// A draft's page is a column at most this wide, centered in the preview:
/// Notion's reading column (`max-w-… mx-auto`).
pub const PAGE_W: u16 = 72;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Normal,
    /// Typing the `/` filter.
    Filter,
    /// The agent box: `c` for a new agent, `r` to reply to the selected
    /// tab's agent, both in a box over the middle; `d` for a draft and `e`
    /// to change one, written on the draft's page in the preview.
    Ask,
    Help,
}

pub enum Act {
    None,
    Quit,
}

/// A row of the list: a draft (they come first) or a tab, as an index into
/// `drafts` or `tabs`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Row {
    Draft(usize),
    Tab(usize),
}

/// What the agent box writes, and where ⏎ sends it.
#[derive(Clone)]
pub enum Target {
    /// `c`: an agent in a new tab, now.
    Agent,
    /// `d` (a new one) or `e`: draft `id`. Each change is saved to it as you
    /// type; ⏎ sends it to a new agent, esc leaves it for later.
    Edit(String),
    /// `r`: an agent already running.
    Reply(ReplyTo),
}

impl Target {
    /// Which kept text the box shows: `c` its own, a reply its own. A draft
    /// is its own text, kept in the draft.
    fn slot(&self) -> Option<usize> {
        match self {
            Target::Agent => Some(0),
            Target::Reply(_) => Some(1),
            Target::Edit(_) => None,
        }
    }
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

/// Per shown row, the characters the filter matched: in its name (a draft's
/// prompt), in its title.
pub type Hits = (Vec<usize>, Vec<usize>);

/// A finished close: its status line, and the tab to show again if it failed.
type Closed = (String, Option<String>);

/// A draft's image in the preview: Kitty image `id`, drawn `cols`×`rows`
/// cells from preview line `line` down.
pub struct PImg {
    pub line: usize,
    pub id: u32,
    pub cols: u16,
    pub rows: u16,
}

/// The images al has sent the terminal, newest first, and the bytes not yet
/// written. One per file and size.
#[derive(Default)]
struct Images {
    sent: Vec<((PathBuf, u16, u16), u32)>,
    out: Vec<u8>,
    next: u32,
}

impl Images {
    /// The id of `key`'s image, sending the PNG when the terminal hasn't got it.
    fn id_for(&mut self, key: (PathBuf, u16, u16), png: &str) -> u32 {
        if let Some(i) = self.sent.iter().position(|(k, _)| *k == key) {
            let e = self.sent.remove(i);
            let id = e.1;
            self.sent.insert(0, e);
            return id;
        }
        self.next += 1;
        let id = gfx::image_id(self.next);
        self.out.extend(gfx::transmit(id, png, key.1, key.2));
        self.sent.insert(0, (key, id));
        while self.sent.len() > KEEP_IMAGES {
            if let Some((_, old)) = self.sent.pop() {
                self.out.extend(gfx::delete(old));
            }
        }
        id
    }
}

/// An image file readied for the terminal (drafts::load_pic); None while it loads.
type PicState = Option<Result<Pic, String>>;

pub struct App {
    pub pal: Palette,
    ws: String,
    me: String,
    /// The Herdr space's name.
    pub space: String,
    pub tabs: Vec<Tab>,
    /// This space's drafts, newest first: the list shows them above the tabs.
    pub drafts: Vec<Draft>,
    /// The drafts file's time when last read.
    drafts_seen: Option<SystemTime>,
    /// The draft `x` deleted last: `u` brings it back.
    undo: Option<Draft>,
    /// Rows shown, in order: drafts, then tabs (each the filter's best first).
    pub view: Vec<Row>,
    pub hits: Vec<Hits>,
    /// The row the filter matched best: the cursor goes there as you type.
    best: usize,
    /// The selected row's place in `view`.
    pub cur: usize,
    pub list_top: usize,
    /// The row the preview shows (`key_of`).
    preview_of: Option<String>,
    /// Its focused pane's latest lines, ending with its screen; or a draft's
    /// prompt and images.
    pub preview: Vec<Line>,
    /// A draft reads from its top; a pane from its bottom, like a terminal.
    pub top_aligned: bool,
    /// Rows the preview is scrolled away from where it starts: up from the
    /// bottom (a pane), down from the top (a draft).
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
    /// What the last action did (a copy, a draft saved or deleted): a box in
    /// the corner for a moment. False draws it as a failure.
    pub toast: Option<(String, bool, Instant)>,
    pub lay: Layout,
    /// Tabs `x` closed: hidden even if Herdr still lists them for a moment.
    closed: HashSet<String>,
    closed_tx: Sender<Closed>,
    closed_rx: Receiver<Closed>,
    /// The agent box's text, kept across Esc until it's sent.
    pub ask: Field,
    /// Files behind the box's `[Image #N]` tags (N - 1 indexes this).
    ask_images: Vec<PathBuf>,
    /// Where the box's text goes.
    pub target: Target,
    /// The texts of the boxes not open (Target::slot), swapped in when they open again.
    parked: [(Field, Vec<PathBuf>); 2],
    /// What ^c last cleared from the open box: ^z brings it back.
    cleared: Option<(Field, Vec<PathBuf>)>,
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
    /// Set when the terminal draws Kitty images: a draft's images show in its preview.
    pub gfx: Option<Gfx>,
    pics: HashMap<PathBuf, PicState>,
    pic_tx: Sender<(PathBuf, Result<Pic, String>)>,
    pic_rx: Receiver<(PathBuf, Result<Pic, String>)>,
    imgs: Images,
    /// The selected draft's images, placed on its preview's lines.
    pub pimgs: Vec<PImg>,
    /// The caret on the page `d` / `e` is writing: its line and column.
    pub caret: Option<(usize, usize)>,
    /// False for --snapshot: nothing is focused, closed, sent or saved.
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
        let (pic_tx, pic_rx) = mpsc::channel();
        let mut app = App {
            pal,
            ws,
            me,
            space,
            tabs,
            drafts: Vec::new(),
            drafts_seen: None,
            undo: None,
            view: Vec::new(),
            hits: Vec::new(),
            best: 0,
            cur: 0,
            list_top: 0,
            preview_of: None,
            preview: Vec::new(),
            top_aligned: false,
            scroll: 0,
            transcript: None,
            in_transcript: false,
            fetched: Instant::now(),
            mode: Mode::Normal,
            filter: String::new(),
            count: None,
            msg: None,
            toast: None,
            lay: Layout::default(),
            closed: HashSet::new(),
            closed_tx,
            closed_rx,
            ask: Field::default(),
            ask_images: Vec::new(),
            target: Target::Agent,
            parked: Default::default(),
            cleared: None,
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
            gfx: None,
            pics: HashMap::new(),
            pic_tx,
            pic_rx,
            imgs: Images::default(),
            pimgs: Vec::new(),
            caret: None,
            live: true,
            sent: None,
            copied: None,
            opened: None,
        };
        app.reload_drafts();
        app.set_view(None);
        Ok(app)
    }

    pub fn selected_row(&self) -> Option<Row> {
        self.view.get(self.cur).copied()
    }

    /// The selected tab; None on a draft.
    pub fn selected(&self) -> Option<&Tab> {
        match self.selected_row()? {
            Row::Tab(i) => self.tabs.get(i),
            Row::Draft(_) => None,
        }
    }

    pub fn selected_draft(&self) -> Option<&Draft> {
        match self.selected_row()? {
            Row::Draft(i) => self.drafts.get(i),
            Row::Tab(_) => None,
        }
    }

    /// A row's lasting name: its tab's id, or its draft's.
    fn key_of(&self, r: Row) -> String {
        match r {
            Row::Tab(i) => self.tabs[i].id.clone(),
            Row::Draft(i) => draft_key(&self.drafts[i].id),
        }
    }

    fn selected_key(&self) -> Option<String> {
        self.selected_row().map(|r| self.key_of(r))
    }

    pub fn flash(&mut self, m: impl Into<String>) {
        self.msg = Some((m.into(), Instant::now()));
    }

    /// A toast: what an action just did.
    pub fn toast(&mut self, m: impl Into<String>) {
        self.toast = Some((m.into(), true, Instant::now()));
    }

    /// A toast saying an action didn't happen.
    fn toast_err(&mut self, m: impl Into<String>) {
        self.toast = Some((m.into(), false, Instant::now()));
    }

    /// Recompute what's shown (the filter), keeping the cursor on row `keep`
    /// (`key_of`) when it's still there and on the same row otherwise.
    fn set_view(&mut self, keep: Option<String>) {
        let q = self.filter.trim().to_string();
        let mut v: Vec<(Row, i64, Hits)> = Vec::new();
        // Drafts first: their prompt, then their folder.
        for (i, d) in self.drafts.iter().enumerate() {
            if q.is_empty() {
                v.push((Row::Draft(i), 0, Default::default()));
                continue;
            }
            let text = fuzzy::score(&q, &d.flat());
            let cwd = fuzzy::score(&q, &herdr::tilde(&d.cwd.to_string_lossy())).map(|(s, _)| s - 16);
            let Some(best) = [text.as_ref().map(|x| x.0), cwd].into_iter().flatten().max() else { continue };
            let hits = match text {
                Some((s, h)) if s == best => (h, Vec::new()),
                _ => Default::default(),
            };
            v.push((Row::Draft(i), best, hits));
        }
        let drafts = v.len();
        for (i, t) in self.tabs.iter().enumerate() {
            if q.is_empty() {
                v.push((Row::Tab(i), 0, Default::default()));
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
            v.push((Row::Tab(i), best, hits));
        }
        if !q.is_empty() {
            // Drafts stay on top, each kind best first.
            v[..drafts].sort_by_key(|x| std::cmp::Reverse(x.1));
            v[drafts..].sort_by_key(|x| std::cmp::Reverse(x.1));
        }
        // The best of all, first among equals.
        self.best = v.iter().enumerate().max_by(|a, b| a.1 .1.cmp(&b.1 .1).then(b.0.cmp(&a.0))).map_or(0, |(k, _)| k);
        self.view = v.iter().map(|x| x.0).collect();
        self.hits = v.into_iter().map(|x| x.2).collect();
        let at = keep.and_then(|id| self.view.iter().position(|&r| self.key_of(r) == id));
        self.cur = at.unwrap_or(self.cur).min(self.view.len().saturating_sub(1));
    }

    /// Re-read the tabs and the drafts (the cursor stays on its row), and the preview.
    fn refresh(&mut self) {
        self.fetched = Instant::now();
        let keep = self.selected_key();
        match herdr::tabs(&self.ws, &self.me) {
            Ok((space, mut list)) => {
                let live: HashSet<&str> = list.iter().map(|t| t.id.as_str()).collect();
                self.closed.retain(|id| live.contains(id.as_str()));
                list.retain(|t| !self.closed.contains(&t.id));
                self.space = space;
                self.tabs = list;
            }
            // A hiccup keeps what's on screen.
            Err(e) => self.flash(e),
        }
        self.reload_drafts();
        self.set_view(keep);
        if !self.holding() {
            self.load_preview();
        }
    }

    // ---- drafts ------------------------------------------------------------

    /// This space's drafts from the file, when it changed (another al may
    /// have written it).
    fn reload_drafts(&mut self) {
        let stamp = drafts::stamp();
        if stamp.is_some() && stamp == self.drafts_seen {
            return;
        }
        self.drafts_seen = stamp;
        self.drafts = drafts::load().into_iter().filter(|d| d.belongs(&self.ws, &self.space)).collect();
    }

    /// Save `d` (a new one on top), in the file too unless --snapshot, and
    /// show its preview afresh.
    fn put_draft(&mut self, d: Draft) -> bool {
        let ok = self.store_draft(d);
        if ok {
            self.preview_of = None;
        }
        ok
    }

    /// Save `d` (a new one on top), in the file too unless --snapshot.
    fn store_draft(&mut self, d: Draft) -> bool {
        if self.live {
            if let Err(e) = drafts::put(&d) {
                self.toast_err(format!("couldn't save the draft: {e}"));
                return false;
            }
            self.drafts_seen = None;
            self.reload_drafts();
        } else {
            match self.drafts.iter_mut().find(|x| x.id == d.id) {
                Some(x) => *x = d,
                None => self.drafts.insert(0, d),
            }
        }
        true
    }

    /// Take draft `id` out, from the file too unless --snapshot.
    fn drop_draft(&mut self, id: &str) -> Option<Draft> {
        let i = self.drafts.iter().position(|d| d.id == id)?;
        if self.live {
            if let Err(e) = drafts::remove(id) {
                self.toast_err(format!("couldn't delete the draft: {e}"));
                return None;
            }
        }
        Some(self.drafts.remove(i))
    }

    /// `d`: a new draft, there at once: on top of the list, selected, and
    /// its page open on the right to write. It's saved as you type, so ⏎
    /// sends it and esc leaves it for later.
    fn new_draft(&mut self) {
        let d = Draft {
            id: drafts::new_id(),
            workspace: self.ws.clone(),
            space: self.space.clone(),
            cwd: self.ask_cwd.clone(),
            text: String::new(),
            images: Vec::new(),
            created: drafts::now(),
        };
        let id = d.id.clone();
        // An empty draft matches no filter: show everything, so it's on top.
        self.filter.clear();
        if self.put_draft(d) {
            self.set_view(Some(draft_key(&id)));
            self.show_box(Target::Edit(id));
        }
    }

    /// After a key or a paste in a draft's box: the change saved to the
    /// draft, its new images copied beside it. `before` is the text and the
    /// image count as they were.
    fn sync_draft(&mut self, before: (String, usize)) {
        let Target::Edit(id) = self.target.clone() else { return };
        if self.mode != Mode::Ask || (self.ask.text.clone(), self.ask_images.len()) == before {
            return;
        }
        let Some(old) = self.drafts.iter().find(|d| d.id == id).cloned() else { return };
        let text = self.ask.text.clone();
        if self.live {
            let kept = drafts::keep_images(&id, &text, &self.ask_images);
            // A copied image is the same picture: keep it ready under its new name.
            for (from, to) in self.ask_images.iter().zip(&kept) {
                if from != to {
                    if let Some(pic) = self.pics.remove(from) {
                        self.pics.insert(to.clone(), pic);
                    }
                }
            }
            self.ask_images = kept;
        }
        let key = self.selected_key();
        if self.store_draft(Draft { text, images: self.ask_images.clone(), ..old }) {
            self.set_view(key);
        }
    }

    /// ⏎ in a draft's box: off to a new agent, in the draft's folder, and
    /// the draft goes (its tab shows up in the list). An empty one just closes.
    fn send_draft(&mut self, id: String) {
        let text = self.ask.text.trim().to_string();
        if text.is_empty() {
            return self.close_box();
        }
        let cwd = self.drafts.iter().find(|d| d.id == id).map_or_else(|| self.ask_cwd.clone(), |d| d.cwd.clone());
        let prompt = agent::with_images(&text, &self.ask_images);
        if self.drop_draft(&id).is_none() {
            return;
        }
        self.mode = Mode::Normal;
        self.preview_of = None;
        self.ask = Field::default();
        self.ask_images.clear();
        self.cleared = None;
        if self.live {
            agent::spawn(prompt, cwd, self.bg_tx.clone());
        } else {
            self.sent = Some(prompt);
        }
        self.set_view(None);
        self.toast(format!("sent: {} is starting in a new tab", self.ask_kind));
    }

    /// Esc (or ^c on an empty box) out of a draft: it stays, as saved. One
    /// left empty goes: a `d` you didn't use, or one ^c cleared, which `u`
    /// then brings back with what it had.
    fn leave_draft(&mut self, id: &str) {
        if !self.ask.text.trim().is_empty() {
            self.toast("kept the draft · ⏎ on it sends it");
            return;
        }
        let Some(d) = self.drop_draft(id) else { return };
        self.set_view(None);
        if let Some((f, images)) = self.cleared.take().filter(|(f, _)| !f.text.trim().is_empty()) {
            self.undo = Some(Draft { text: f.text, images, ..d });
            self.toast("deleted the emptied draft · u brings it back");
        }
    }

    /// ⏎ on a draft: its agent starts in a new tab, in the draft's folder,
    /// and the draft goes (its tab shows up in the list).
    fn run_draft(&mut self) {
        let Some(d) = self.selected_draft().cloned() else { return };
        let prompt = agent::with_images(&d.text, &d.images);
        if self.drop_draft(&d.id).is_none() {
            return;
        }
        if self.live {
            agent::spawn(prompt, d.cwd.clone(), self.bg_tx.clone());
        } else {
            self.sent = Some(prompt);
        }
        self.set_view(None);
        self.toast(format!("sent: {} is starting in a new tab", self.ask_kind));
    }

    /// x / ; on a draft: gone, until `u`.
    fn delete_draft(&mut self, id: &str) {
        if let Some(d) = self.drop_draft(id) {
            self.undo = Some(d);
            self.set_view(None);
            self.toast("deleted the draft · u brings it back");
        }
    }

    /// `u`: the draft x deleted last, back on top.
    fn undo(&mut self) {
        let Some(d) = self.undo.take() else {
            self.flash("no deleted draft to bring back");
            return;
        };
        let key = draft_key(&d.id);
        if self.put_draft(d) {
            self.set_view(Some(key));
            self.toast("the draft is back");
        }
    }

    /// `e` (or `r`) on a draft: its page, open to write, saved as you type.
    fn edit_draft(&mut self) {
        let Some(id) = self.selected_draft().map(|d| d.id.clone()) else {
            self.flash("e changes a draft (d writes one)");
            return;
        };
        self.show_box(Target::Edit(id));
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

    /// The preview's text area (`preview_text`): (rows, columns).
    pub fn preview_size(&self) -> (usize, usize) {
        self.preview_text().map_or((1, 10), |t| ((t.height as usize).max(1), (t.width as usize).max(10)))
    }

    /// Whether the agent box is writing a draft on its page in the preview
    /// (`d`, `e`). Without a preview it's the box over the middle, as `c`.
    pub fn page_editing(&self) -> bool {
        self.mode == Mode::Ask && matches!(self.target, Target::Edit(_)) && self.lay.preview.is_some()
    }

    /// Whether the preview shows a draft's page: the selected draft, or the
    /// one being written.
    pub fn shows_page(&self) -> bool {
        self.page_editing() || self.selected_draft().is_some()
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
        while let Ok((path, pic)) = self.pic_rx.try_recv() {
            let shown = self.selected_draft().is_some_and(|d| d.images.contains(&path)) || (self.page_editing() && self.ask_images.contains(&path));
            self.pics.insert(path, Some(pic));
            if shown && !self.holding() {
                self.load_preview();
            }
            dirty = true;
        }
        if self.msg.as_ref().is_some_and(|(_, at)| at.elapsed() > FLASH) {
            self.msg = None;
            dirty = true;
        }
        if self.toast.as_ref().is_some_and(|(_, _, at)| at.elapsed() > TOAST) {
            self.toast = None;
            dirty = true;
        }
        if self.live && self.fetched.elapsed() > REFRESH {
            self.refresh();
            dirty = true;
        }
        dirty
    }

    /// Before drawing: the preview of the selected row, and the list's scroll.
    pub fn prepare(&mut self) {
        let key = self.selected_key();
        if key != self.preview_of {
            self.preview_of = key;
            self.reset_preview();
            self.load_preview();
        } else if self.page_editing() {
            // The page follows the typing.
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
    /// previewed tab's (or draft's) folder.
    fn find_links(&mut self) {
        let cwd = match (self.selected(), self.selected_draft()) {
            (Some(t), _) => PathBuf::from(&t.cwd),
            (_, Some(d)) => d.cwd.clone(),
            _ => PathBuf::new(),
        };
        if self.lay.preview.is_none() || cwd.as_os_str().is_empty() || self.page_editing() {
            self.links.clear();
            return;
        }
        self.finder.set_cwd(&cwd);
        let w = self.window(self.preview_size().0);
        let texts: Vec<(usize, String)> = w.map(|i| (i, select::plain(&self.lines()[i]))).collect();
        let mut links = Vec::new();
        for (i, s) in texts {
            self.finder.find(i, &s, &mut links);
        }
        self.links = links;
    }

    /// Bytes for the terminal (images to send or free), to write before drawing.
    pub fn take_gfx(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.imgs.out)
    }

    /// Free every image al sent, for quitting.
    pub fn clear_images(&mut self) -> Vec<u8> {
        for (_, id) in self.imgs.sent.drain(..) {
            self.imgs.out.extend(gfx::delete(id));
        }
        self.take_gfx()
    }

    // ---- the preview -------------------------------------------------------

    /// Another row is selected: back to its live screen (a draft's top), unscrolled.
    fn reset_preview(&mut self) {
        self.clear_sel();
        self.scroll = 0;
        self.transcript = None;
        self.in_transcript = false;
    }

    fn load_preview(&mut self) {
        self.caret = None;
        if self.page_editing() {
            self.editor_page();
            return;
        }
        if let Some(d) = self.selected_draft().cloned() {
            self.page(&d.text, &d.images);
            return;
        }
        self.top_aligned = false;
        self.pimgs.clear();
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

    /// The page `d` / `e` is writing: the box's text and images as the
    /// draft will read, the caret where the cursor is, kept in view.
    fn editor_page(&mut self) {
        let (text, images) = (self.ask.text.clone(), self.ask_images.clone());
        self.page(&text, &images);
        let (h, w) = self.preview_size();
        // The page's first lines are the text's rows (`page`).
        let rows = ui::word_rows(&text, w);
        let cr = rows.iter().rposition(|r| r.start <= self.ask.cur).unwrap_or(0);
        self.caret = Some((cr, text[rows[cr].start..self.ask.cur].width()));
        if cr < self.scroll {
            self.scroll = cr;
        } else if cr >= self.scroll + h {
            self.scroll = cr + 1 - h;
        }
    }

    /// A draft's page: its prompt, wrapped at its words, then under it each
    /// image it tags: the picture itself where the terminal draws them
    /// (gfx.rs), else the file it's in.
    fn page(&mut self, body: &str, images: &[PathBuf]) {
        let (h, w) = self.preview_size();
        let (text, tag, dim) = (Style::new().fg(self.pal.bright), Style::new().fg(self.pal.accent), Style::new().fg(self.pal.dim));
        let tags = agent::image_tags(body);
        let mut lines: Vec<Line> = Vec::new();
        for row in ui::word_rows(body, w) {
            let mut line = Line::new();
            let mut at = row.start;
            for (t, _) in tags.iter().filter(|(t, _)| t.start < row.end && t.end > row.start) {
                let (a, b) = (t.start.max(row.start), t.end.min(row.end));
                if a > at {
                    line.push((body[at..a].to_string(), text));
                }
                line.push((body[a..b].to_string(), tag));
                at = b;
            }
            if at < row.end {
                line.push((body[at..row.end].to_string(), text));
            }
            lines.push(line);
        }
        self.pimgs.clear();
        for (n, path) in drafts::tagged(body, images) {
            lines.push(Line::new());
            let mut label: Line = vec![(format!("[Image #{n}]"), tag)];
            let file = herdr::tilde(&path.to_string_lossy());
            let Some(g) = self.gfx else {
                label.push((format!("  {file}"), dim));
                lines.push(label);
                continue;
            };
            let state = self.pics.get(&path).map(|s| s.as_ref().map(|r| r.as_ref().map(|p| (p.w, p.h)).map_err(Clone::clone)));
            match state {
                Some(Some(Ok((pw, ph)))) => {
                    // Each picture fits the panel with its label above it.
                    let (cols, rows) = fit(pw, ph, g, w, h.saturating_sub(1));
                    let Some(Some(Ok(pic))) = self.pics.get(&path) else { continue };
                    let id = self.imgs.id_for((path.clone(), cols, rows), &pic.b64);
                    label.push((format!("  {pw}×{ph}"), dim));
                    lines.push(label);
                    self.pimgs.push(PImg { line: lines.len(), id, cols, rows });
                    lines.extend((0..rows).map(|_| Line::new()));
                    continue;
                }
                Some(Some(Err(e))) => label.push((format!("  couldn't show {file}: {e}"), dim)),
                Some(None) => label.push(("  loading…".into(), dim)),
                None => {
                    self.load_pic(path.clone());
                    label.push(("  loading…".into(), dim));
                }
            }
            lines.push(label);
        }
        self.preview = lines;
        self.top_aligned = true;
    }

    /// Ready `path` for the terminal, off the UI thread; tick() picks it up.
    fn load_pic(&mut self, path: PathBuf) {
        self.pics.insert(path.clone(), None);
        let tx = self.pic_tx.clone();
        std::thread::spawn(move || {
            let pic = drafts::load_pic(&path);
            let _ = tx.send((path, pic));
        });
    }

    /// What the preview shows: the pane's lines, or the transcript's.
    pub fn lines(&self) -> &[Line] {
        match &self.transcript {
            Some(t) if self.in_transcript => &t.lines,
            _ => &self.preview,
        }
    }

    /// The preview lines shown in `h` rows: a pane's bottom-aligned less the
    /// scroll, its trailing blank lines not counting as content; a draft's
    /// from the top, plus the scroll.
    pub fn window(&self, h: usize) -> Range<usize> {
        if self.top_aligned {
            let end = self.lines().len();
            let s = self.scroll.min(end.saturating_sub(h));
            return s..s.saturating_add(h).min(end);
        }
        let blank = |l: &Line| l.iter().all(|(s, _)| s.trim().is_empty());
        let end = self.lines().iter().rposition(|l| !blank(l)).map_or(0, |i| i + 1);
        let e = end - self.scroll.min(end.saturating_sub(h));
        e.saturating_sub(h)..e
    }

    /// How far the preview can scroll in `h` rows.
    fn max_scroll(&self, h: usize) -> usize {
        let w = self.window(usize::MAX);
        (w.end - w.start).saturating_sub(h)
    }

    fn transcript_colors(&self) -> transcript::Colors {
        let p = &self.pal;
        transcript::Colors { fg: p.fg, bright: p.bright, dim: p.dim, accent: p.accent, green: p.green }
    }

    /// `K` / `J`: scroll the preview up (positive) or back down. A Claude
    /// tab carries on up past its screen into its transcript, which reads
    /// further back as you go; coming back down past the transcript's end
    /// returns to the live screen.
    /// A mark holds the preview to what it was marked in: no crossing
    /// between the screen and the transcript, and lines the transcript loads
    /// above move the mark down with them.
    fn preview_scroll(&mut self, d: isize) {
        let (h, w) = self.preview_size();
        if self.top_aligned {
            let want = (self.scroll as isize).saturating_sub(d).max(0) as usize;
            self.scroll = want.min(self.max_scroll(h));
            return;
        }
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

    /// The preview's text cells: inside its border, a column of padding each
    /// side. A draft's page is narrower: at most PAGE_W columns, centered,
    /// and a row down from the top when there's room.
    pub fn preview_text(&self) -> Option<Rect> {
        let r = self.lay.preview?;
        if r.width <= 4 || r.height <= 2 {
            return None;
        }
        let t = Rect::new(r.x + 2, r.y + 1, r.width - 4, r.height - 2);
        if !self.shows_page() {
            return Some(t);
        }
        let w = t.width.min(PAGE_W);
        let pad = u16::from(t.height > 8);
        Some(Rect::new(t.x + (t.width - w) / 2, t.y + pad, w, t.height - pad))
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

    /// Put `text` on the clipboard, and say so in a toast: "copied {what}".
    fn clip(&mut self, text: String, what: &str) {
        if !self.live {
            self.copied = Some(text);
            self.toast(format!("copied {what}"));
            return;
        }
        match select::copy(&text) {
            Ok(()) => self.toast(format!("copied {what}")),
            Err(e) => self.toast_err(format!("couldn't copy: {e}")),
        }
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
        if !text.is_empty() {
            let n = text.chars().count();
            self.clip(text, &format!("{n} char{}", if n == 1 { "" } else { "s" }));
        }
        if follow {
            self.reset_preview();
        }
        if self.live {
            self.load_preview();
        }
    }

    /// `y` with nothing marked: the selected tab's pane ID (its agent's pane,
    /// else the one shown), for `herdr pane …`; on a draft, its prompt.
    fn copy_pane(&mut self) {
        if let Some(d) = self.selected_draft() {
            let prompt = agent::with_images(&d.text, &d.images);
            self.clip(prompt, "the draft's prompt");
            return;
        }
        let Some(t) = self.selected() else { return };
        match t.agent_pane.clone().or_else(|| t.pane.clone()) {
            Some(p) => self.clip(p.clone(), &format!("pane {p}")),
            None => {
                let m = format!("{} has no pane", t.name());
                self.toast_err(m);
            }
        }
    }

    /// `Y`: the selected tab's agent session ID.
    fn copy_session(&mut self) {
        if self.selected_draft().is_some() {
            self.toast_err("a draft has no session until ⏎ runs it");
            return;
        }
        let Some(t) = self.selected() else { return };
        match t.session.clone() {
            Some(s) => self.clip(s.clone(), &format!("session {s}")),
            None => {
                let m = format!("no agent session in {}", t.name());
                self.toast_err(m);
            }
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
                let before = (self.ask.text.clone(), self.ask_images.len());
                self.paste(&s);
                self.sync_draft(before);
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
                let before = (self.ask.text.clone(), self.ask_images.len());
                self.key_ask(k);
                self.sync_draft(before);
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
            // J / K: the preview, half a panel at a time.
            KeyCode::Char('J') | KeyCode::PageDown => self.preview_scroll(-phalf * n),
            KeyCode::Char('K') | KeyCode::PageUp => self.preview_scroll(phalf * n),
            KeyCode::Char('j') | KeyCode::Down => self.move_by(n),
            KeyCode::Char('k') | KeyCode::Up => self.move_by(-n),
            KeyCode::Char('g' | 'G') | KeyCode::Home | KeyCode::End if count.is_some() => self.go_to(n as usize - 1),
            KeyCode::Char('g') | KeyCode::Home => self.move_by(isize::MIN),
            KeyCode::Char('G') | KeyCode::End => self.move_by(isize::MAX),
            // `;` closes too, so ;;; clears tabs from the home row. On a
            // draft both delete it (u brings it back).
            KeyCode::Char('x' | ';') => self.close_selected(),
            KeyCode::Char('u') => self.undo(),
            // The agent box: c for a new agent (its tab shows up in the
            // list), d for a draft (it shows up on top), e to change a
            // draft, r to reply to the selected tab's agent.
            KeyCode::Char('c') => self.show_box(Target::Agent),
            KeyCode::Char('d') => self.new_draft(),
            KeyCode::Char('e') => self.edit_draft(),
            // l, vim's right: from the list into the selected draft's page.
            KeyCode::Char('l') if self.selected_draft().is_some() => self.edit_draft(),
            KeyCode::Char('r') if self.selected_draft().is_some() => self.edit_draft(),
            KeyCode::Char('r') => self.open_reply(),
            KeyCode::Char('y') if !ctrl => self.copy_pane(),
            KeyCode::Char('Y') => self.copy_session(),
            KeyCode::Enter | KeyCode::Char('o') => self.enter(),
            KeyCode::Char('/') => self.mode = Mode::Filter,
            KeyCode::Char('?') => self.mode = Mode::Help,
            _ => {}
        }
        Act::None
    }

    /// Typing the filter: the list narrows to the best matches as you type,
    /// ⏎ goes to the best one (and stops typing; on a draft it only stops,
    /// so a filter never runs one), Esc stops typing and keeps the filter (so
    /// j/k and x work on what's left; Esc again clears it).
    fn key_filter(&mut self, k: KeyEvent, ctrl: bool) -> Act {
        match k.code {
            KeyCode::Char('c') if ctrl => return Act::Quit,
            KeyCode::Esc | KeyCode::Tab => self.mode = Mode::Normal,
            KeyCode::Enter => {
                self.mode = Mode::Normal;
                if self.selected_draft().is_some() {
                    self.flash("⏎ again runs the draft");
                } else {
                    self.go();
                }
            }
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
        let keep = if f.trim().is_empty() { self.selected_key() } else { None };
        self.filter = f;
        self.set_view(keep.clone());
        // Narrowing puts the cursor on the best match; clearing keeps your row.
        if keep.is_none() {
            self.cur = self.best.min(self.view.len().saturating_sub(1));
        }
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

    /// Row `n` (0-based) in the list, as 12G.
    fn go_to(&mut self, n: usize) {
        self.move_by(n as isize - self.cur as isize);
    }

    /// ⏎ / o: go to the selected tab, or run the selected draft.
    fn enter(&mut self) {
        if self.selected_draft().is_some() {
            self.run_draft();
        } else {
            self.go();
        }
    }

    /// Switch Herdr to the selected tab. al stays open behind it, so it's
    /// still there when you come back; q or esc quits.
    fn go(&mut self) {
        let Some(t) = self.selected() else { return };
        let (id, name) = (t.id.clone(), t.name().to_string());
        if self.live {
            if let Err(e) = herdr::focus_tab(&id) {
                self.flash(e);
                return;
            }
        }
        self.flash(format!("showing {name}"));
    }

    /// x / ;: close the selected tab now, no questions, like ctrl+alt+x; or
    /// delete the selected draft.
    fn close_selected(&mut self) {
        if let Some(id) = self.selected_draft().map(|d| d.id.clone()) {
            self.delete_draft(&id);
            return;
        }
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
        self.show_box(Target::Reply(ReplyTo { pane, label }));
    }

    /// Open the agent box for `to`, with that kind of box's text: the open
    /// box's goes back to its slot (an edit's is dropped), and `to`'s comes
    /// out, an edit's from its draft.
    fn show_box(&mut self, to: Target) {
        let kept = (std::mem::take(&mut self.ask), std::mem::take(&mut self.ask_images));
        if let Some(i) = self.target.slot() {
            self.parked[i] = kept;
        }
        match (&to, to.slot()) {
            (Target::Edit(id), _) => {
                if let Some(d) = self.drafts.iter().find(|d| &d.id == id) {
                    self.ask = Field { text: d.text.clone(), ..Default::default() };
                    self.ask_images = d.images.clone();
                }
            }
            (_, Some(i)) => (self.ask, self.ask_images) = std::mem::take(&mut self.parked[i]),
            (_, None) => {}
        }
        self.target = to;
        self.ask.end();
        self.cleared = None;
        self.mode = Mode::Ask;
        // The box is what's happening now: an old toast would sit on it.
        self.toast = None;
        // A draft is written on its page in the preview, from the top.
        if self.page_editing() {
            self.reset_preview();
        }
    }

    /// Esc, ^c or ⏎ in the box: back to the list. Writing a page took over
    /// the preview, so it shows the selected row again.
    fn close_box(&mut self) {
        if self.page_editing() {
            self.preview_of = None;
        }
        self.mode = Mode::Normal;
        if let Target::Edit(id) = self.target.clone() {
            self.leave_draft(&id);
        }
    }

    /// Where the box's agent would start: a draft being changed keeps its own folder.
    pub fn box_cwd(&self) -> PathBuf {
        match &self.target {
            Target::Edit(id) => self.drafts.iter().find(|d| &d.id == id).map_or_else(|| self.ask_cwd.clone(), |d| d.cwd.clone()),
            _ => self.ask_cwd.clone(),
        }
    }

    fn send_ask(&mut self) {
        if let Target::Edit(id) = self.target.clone() {
            return self.send_draft(id);
        }
        self.close_box();
        let text = self.ask.text.trim().to_string();
        if text.is_empty() {
            return;
        }
        let prompt = agent::with_images(&text, &self.ask_images);
        self.ask = Field::default();
        self.ask_images.clear();
        if let Target::Reply(to) = self.target.clone() {
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
        let shift = k.modifiers.contains(KeyModifiers::SHIFT);
        // The columns the text wraps to: the page's, or the box's.
        let wrap = if self.page_editing() { self.preview_size().1 } else { ui::ask_width(self.lay.screen.width) };
        let page = self.page_editing();
        let f = &mut self.ask;
        match k.code {
            // Esc drops a selection first, then leaves the box (a draft stays, saved).
            KeyCode::Esc if f.selection().is_some() => f.anchor = None,
            KeyCode::Esc => self.close_box(),
            // ^c copies the selection (⌘c is Ghostty's own); with none it
            // clears the input, and on an empty box it leaves. ^x cuts, ^z
            // brings back what ^c cleared.
            KeyCode::Char('c') if ctrl => self.ctrl_c(),
            KeyCode::Char('x') if ctrl => self.cut(),
            KeyCode::Char('z') if ctrl => self.unclear(),
            // Newline: shift+Enter (the kitty keyboard protocol tells it from
            // Enter; see main.rs), alt+Enter, or ^j anywhere.
            KeyCode::Enter if alt || k.modifiers.contains(KeyModifiers::SHIFT) => f.insert("\n"),
            KeyCode::Char('j') if ctrl => f.insert("\n"),
            KeyCode::Enter => self.send_ask(),
            // ^i: the --path file. Without the kitty protocol ^i is a Tab, so Tab does it too.
            KeyCode::Char('i') if ctrl => self.insert_ask_path(),
            KeyCode::Tab => self.insert_ask_path(),
            KeyCode::Char('v') if ctrl => self.paste_image(),
            // ^l: the whole text, its images too.
            KeyCode::Char('l') if ctrl => {
                f.clear();
                self.ask_images.clear();
            }
            // ↑↓: a row up or down, as the page or the box wraps the text;
            // ⇧↑ ⇧↓ select along. (⌥↑ ⌥↓ go by line: Field::key.)
            KeyCode::Up | KeyCode::Down if !alt => {
                let rows = if page { ui::word_rows(&f.text, wrap) } else { ui::prompt_rows(&f.text, wrap) };
                f.vertical_by(&rows, if k.code == KeyCode::Up { -1 } else { 1 }, shift);
            }
            _ => {
                f.key(&k);
            }
        }
    }

    /// ^c in the box: copy the selection; else clear the input (^z brings
    /// it back); on an empty box, leave it.
    fn ctrl_c(&mut self) {
        if let Some(text) = self.ask.selected().map(String::from) {
            let n = text.chars().count();
            return self.clip(text, &format!("{n} char{}", if n == 1 { "" } else { "s" }));
        }
        if self.ask.text.is_empty() {
            return self.close_box();
        }
        self.cleared = Some((std::mem::take(&mut self.ask), std::mem::take(&mut self.ask_images)));
        self.toast("cleared · ^z brings it back · ^c again leaves");
    }

    /// ^x in the box: the selection onto the clipboard, and out of the text.
    fn cut(&mut self) {
        let Some(text) = self.ask.selected().map(String::from) else { return };
        let n = text.chars().count();
        self.clip(text, &format!("{n} char{}", if n == 1 { "" } else { "s" }));
        self.ask.delete_selection();
    }

    /// ^z in the box: what ^c cleared, back (and what's there now, kept
    /// for another ^z).
    fn unclear(&mut self) {
        let Some(c) = self.cleared.as_mut() else { return };
        std::mem::swap(&mut self.ask, &mut c.0);
        std::mem::swap(&mut self.ask_images, &mut c.1);
        self.ask.end();
        self.toast("brought it back");
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
            // Click a row to select it; click it again quickly to go to it
            // (or run it, a draft), as ⏎.
            MouseEventKind::Down(MouseButton::Left) if in_list && m.row > list.y && m.row + 1 < list.bottom() => {
                let k = self.list_top + (m.row - list.y - 1) as usize;
                if k < self.view.len() {
                    let again = self.last_click.is_some_and(|(at, prev)| prev == k && at.elapsed() < MULTI_CLICK);
                    self.last_click = Some((Instant::now(), k));
                    self.go_to(k);
                    if again {
                        self.enter();
                    }
                }
            }
            _ => {}
        }
        Act::None
    }
}

fn draft_key(id: &str) -> String {
    format!("draft:{id}")
}

/// The cells a `w`×`h` pixel image fills: its own size at most, else as big
/// as `cols`×`rows` cells allow, its shape kept.
fn fit(w: u32, h: u32, g: Gfx, cols: usize, rows: usize) -> (u16, u16) {
    let (w, h) = (f64::from(w.max(1)), f64::from(h.max(1)));
    let (cw, ch) = (f64::from(g.cell_w.max(1)), f64::from(g.cell_h.max(1)));
    let s = 1f64.min(cols as f64 * cw / w).min(rows.max(1) as f64 * ch / h);
    let c = ((w * s / cw).round() as usize).clamp(1, cols.max(1));
    let r = ((h * s / ch).round() as usize).clamp(1, rows.max(1));
    (c.min(gfx::MAX_CELLS as usize) as u16, r.min(gfx::MAX_CELLS as usize) as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_images_keeping_their_shape() {
        let g = Gfx { cell_w: 10, cell_h: 20 };
        // Small: its own size.
        assert_eq!(fit(100, 100, g, 80, 30), (10, 5));
        // Too wide: the width it has, shape kept.
        assert_eq!(fit(1600, 400, g, 80, 30), (80, 10));
        // Too tall: the rows it has.
        assert_eq!(fit(400, 1600, g, 80, 30), (15, 30));
        // Never zero.
        assert_eq!(fit(1, 1, g, 80, 0), (1, 1));
    }
}
