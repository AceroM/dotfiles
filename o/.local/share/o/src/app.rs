//! State, keys and the mouse. One prompt, as `claude >` has, named for the
//! configuration ⏎ starts (`claude(opus) >`, config.rs; ⇧tab the next one,
//! ^1…^9 the Nth): write it (as many lines as it takes, images pasted in), ⏎
//! starts that agent with it in a new Rex tab, and the prompt empties for
//! the next one.
//! A pasted image is an `[Image #N]` tag in the text, its file listed at the
//! end of what's sent; it isn't drawn. ⌥c copies the text without them, its
//! spaces and blank lines tidied (field::plain).
//!
//! Drafts (drafts.rs): ^s keeps the prompt as one, saved as it's
//! written from then on (esc leaves it for later, ⏎ sends it and it goes);
//! ^g goes through this session's drafts, a list in the prompt's place with
//! al's keys: j k, ⏎ sends, e edits, x deletes, u brings it back, d a new one.
//! The selected draft's images are drawn over the list, small (gfx.rs);
//! a draft being written has its own over its text, all in one row.
//! ⇧↑ ⇧↓ mark drafts (space one, a all): ⏎ then sends the marked ones as
//! one prompt, a preamble over them as tasks (drafts::combine); x deletes them.
//!
//! ⌥⌘N (Rex) shows the images big, in a floating pane (viewer.rs): o keeps
//! the ones the prompt tags now as this pane's, and the ones each send took
//! as its agent's pane's (panes.rs).

use std::collections::HashMap;
use std::ops::Range;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant, SystemTime};

use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;
use unicode_width::UnicodeWidthStr;

use crate::config::{Agent, Profile};
use crate::drafts::{self, Draft};
use crate::field::{self, Field};
use crate::gfx::{self, Gfx, Images, Pic};
use crate::panes::{self, Tagged};
use crate::spawn::{self, Outcome};
use crate::theme::Palette;

/// Presses on one cell this close together count up: 2 takes a word, 3 a line.
const MULTI_CLICK: Duration = Duration::from_millis(400);
const TOAST: Duration = Duration::from_millis(2500);
/// A second esc this soon after the first clears the prompt, as Claude Code's does.
const ESC_AGAIN: Duration = Duration::from_secs(2);

/// A draft is saved once the keys have paused this long (and when it's left).
const SAVE_AFTER: Duration = Duration::from_millis(300);
/// The drafts list shows at most this many drafts, and this much of the
/// selected one under them.
const LIST_ROWS: usize = 8;
const PREVIEW_ROWS: usize = 10;
/// The selected draft's images, over the list: at most this many rows tall
/// (a label under each takes one more).
const IMG_ROWS: usize = 8;
/// The draft being written's images, over its text: all in a row and all
/// as tall, this many rows (a label under each takes one more) or as tall
/// as they can all be side by side, down to EDIT_IMG_MIN.
const EDIT_IMG_ROWS: usize = 8;
const EDIT_IMG_MIN: usize = 2;

pub enum Act {
    None,
    Quit,
    /// ^l: clear the screen, the prompt at its top (main.rs).
    ClearScreen,
}

/// Prompts kept for ↑, the newest last.
const HISTORY: usize = 500;

/// Narrower than this many columns of text, the prompt shows `>` only, not
/// the configuration's name.
const NAMED_MIN_TEXT: usize = 20;

/// A prompt sent: its agent (the configuration's name, or `↳tab` for a
/// reply), its text, and how the start went (None while it's starting).
pub struct Sent {
    pub name: String,
    pub text: String,
    pub plan: bool,
    pub outcome: Option<Outcome>,
    /// The images it took: its agent's pane's, once it's there (panes.rs).
    pub images: Tagged,
}

/// Where things are, in lines from the prompt's first.
#[derive(Clone, Copy, Default)]
pub struct Lay {
    /// The terminal's size.
    pub width: u16,
    pub screen_h: u16,
    /// Where the text's rows go (the prompt's name and glyph are left of them).
    pub text: Rect,
    /// All of it: the text, a toast, what's starting.
    pub height: u16,
}

/// The drafts list (^g), as laid out: which drafts show, and how much of
/// the selected one's text under them.
#[derive(Clone, Default)]
pub struct ListView {
    /// The first draft in view, and how many are.
    pub top: usize,
    pub shown: usize,
    /// The selected draft's text, wrapped: `preview` of its rows show, and
    /// `more` don't.
    pub rows: Vec<Range<usize>>,
    pub preview: usize,
    pub more: usize,
    /// The rows over the list kept for the selected draft's images (their
    /// labels included); 0: none, when no draft has any.
    pub strip: usize,
    pub thumbs: Vec<Thumb>,
    /// Said where there's no picture: "no images", "loading…", "+2 more".
    pub note: Option<String>,
}

/// The draft being written's images, over its text: `height` rows, their
/// labels included (0: none).
#[derive(Clone, Default)]
pub struct Strip {
    pub height: usize,
    pub thumbs: Vec<Thumb>,
    /// Said where there's no picture: "loading…", "+2 more".
    pub note: Option<String>,
}

/// One of the selected draft's images over the list: Kitty image `id`,
/// `cols`×`rows` cells from column `x` of the list's text, `[Image #n]`.
#[derive(Clone, Debug, PartialEq)]
pub struct Thumb {
    pub x: u16,
    pub id: u32,
    pub cols: u16,
    pub rows: u16,
    pub n: usize,
}

/// An image file readied for the terminal; None while it loads.
type PicState = Option<Result<Pic, String>>;

pub struct Opts {
    /// Where the agents start.
    pub cwd: PathBuf,
    /// What the prompt starts with.
    pub text: String,
    /// The first tab's label (a note's name); empty leaves it to Rex.
    pub label: String,
    /// The configurations (config.rs), and the one to start on.
    pub agents: Vec<Agent>,
    pub start: usize,
    /// This computer's Claude profiles (config.rs), and the one to start
    /// on. Empty: the main one only.
    pub profiles: Vec<Profile>,
    pub profile: usize,
    /// Said in a toast at the start: what was wrong with the config file.
    pub notice: Option<String>,
    /// The most columns o draws in (config.rs); 0: the terminal's width.
    pub max_width: u16,
}

pub struct App {
    pub pal: Palette,
    pub field: Field,
    /// The file behind each tag: `[Image #N]` is `images[N - 1]`.
    pub images: Vec<PathBuf>,
    pub cwd: PathBuf,
    pub label: String,
    pub agents: Vec<Agent>,
    /// Which of `agents` ⏎ starts (⇧tab the next, ^1…^9 the Nth).
    pub agent: usize,
    /// The Claude profiles, the main one first; and the one the claude
    /// configurations start on (^n the next).
    pub profiles: Vec<Profile>,
    pub profile: usize,
    /// ^p: it goes as `/plan …`.
    pub plan: bool,
    /// What ^c or esc esc cleared, or ⏎ sent: ^z brings it back.
    cleared: Option<(Field, Vec<PathBuf>)>,
    /// What ^u ^k ^w ⌥d ⌥⌫ deleted last: ^y puts it back.
    killed: String,
    /// Sent prompts, oldest first: ↑ on the first row goes back through
    /// them (read from the history file at the first ↑).
    history: Option<Vec<(String, Vec<PathBuf>)>>,
    /// The entry ↑ is on, counting back from the newest (0); None: the
    /// prompt being written, kept in `draft` meanwhile.
    hist_at: Option<usize>,
    draft: Option<(Field, Vec<PathBuf>)>,
    esc_at: Option<Instant>,
    /// This session's drafts, newest first (drafts.rs).
    pub drafts: Vec<Draft>,
    /// The drafts file's time when last read.
    drafts_seen: Option<SystemTime>,
    /// This Rex session's id and name, asked for at the first draft.
    scope: Option<(String, String)>,
    /// The draft the prompt is writing, as last saved.
    pub editing: Option<Draft>,
    /// Going through the drafts (^g): the one selected.
    pub list: Option<usize>,
    pub view: ListView,
    /// The draft being written's images, over its text.
    pub pictures: Strip,
    /// The draft being written was opened from the list: esc goes back there.
    from_list: bool,
    /// The prompt that was being written when a draft took its place: its
    /// text, images, configuration and plan mode. Back when the draft is left.
    aside: Option<(Field, Vec<PathBuf>, usize, bool)>,
    /// The drafts `x` deleted last: `u` brings them back.
    undo: Vec<Draft>,
    /// Drafts marked in the list (⇧↑ ⇧↓, space, a), by id: ⏎ sends them as
    /// one prompt, x deletes them.
    pub marked: Vec<String>,
    /// A run of ⇧↑ ⇧↓: the draft it started on, and what was marked before.
    mark_from: Option<(usize, Vec<String>)>,
    /// Kitty images, when the terminal draws them (probe.rs): the files
    /// readied for it, and what it has been sent.
    pub gfx: Option<Gfx>,
    pics: HashMap<PathBuf, PicState>,
    pic_tx: Sender<(PathBuf, Result<Pic, String>)>,
    pic_rx: Receiver<(PathBuf, Result<Pic, String>)>,
    imgs: Images,
    last_key: Instant,
    pub toast: Option<(String, bool, Instant)>,
    pub sent: Vec<Sent>,
    pub sent_at: Option<usize>,
    /// ⏎ on a send still starting: focus its tab the moment it exists.
    focus_next: Option<usize>,
    /// Sends that finished, to print above the prompt.
    done: Vec<usize>,
    sent_tx: Sender<(usize, Outcome)>,
    sent_rx: Receiver<(usize, Outcome)>,
    /// The most columns o draws in (config.rs); 0: the terminal's width.
    max_width: u16,
    pub lay: Lay,
    /// The text's rows, as `lay.text` wraps them.
    pub rows: Vec<Range<usize>>,
    /// The first of `lines` in view.
    pub scroll: usize,
    /// The cursor, text and width the view last followed: the wheel can
    /// leave the cursor out of view until it moves.
    followed: Option<(usize, usize, Option<usize>, usize, u16)>,
    /// A press in the text: the span it took, and how many presses in a row.
    press: Option<(Range<usize>, u8)>,
    last_press: Option<(Instant, u16, u16, u8)>,
    /// This pane (REX_BLOCK), whose images ⌥⌘N shows (panes.rs); None:
    /// --snapshot, tests.
    pub block: Option<String>,
    /// What was last kept as its images; None: nothing yet (the first time
    /// clears what an o before this one left).
    published: Option<Tagged>,
    /// False for --snapshot: nothing is sent or copied, only noted.
    pub live: bool,
    pub would_send: Option<String>,
    pub would_copy: Option<String>,
}

impl App {
    pub fn new(pal: Palette, opts: Opts) -> App {
        let (sent_tx, sent_rx) = mpsc::channel();
        let (pic_tx, pic_rx) = mpsc::channel();
        let mut field = Field { text: opts.text, ..Default::default() };
        field.end();
        let toast = opts.notice.map(|m| (m, false, Instant::now()));
        let agents = if opts.agents.is_empty() { crate::config::defaults() } else { opts.agents };
        let agent = opts.start.min(agents.len() - 1);
        let profiles = if opts.profiles.is_empty() { crate::config::find_main() } else { opts.profiles };
        let profile = opts.profile.min(profiles.len() - 1);
        App {
            pal,
            field,
            images: Vec::new(),
            cwd: opts.cwd,
            label: opts.label,
            agents,
            agent,
            profiles,
            profile,
            plan: false,
            cleared: None,
            killed: String::new(),
            history: None,
            hist_at: None,
            draft: None,
            esc_at: None,
            drafts: Vec::new(),
            drafts_seen: None,
            scope: None,
            editing: None,
            list: None,
            view: ListView::default(),
            pictures: Strip::default(),
            from_list: false,
            aside: None,
            undo: Vec::new(),
            marked: Vec::new(),
            mark_from: None,
            gfx: None,
            pics: HashMap::new(),
            pic_tx,
            pic_rx,
            imgs: Images::default(),
            last_key: Instant::now(),
            toast,
            sent: Vec::new(),
            sent_at: None,
            focus_next: None,
            done: Vec::new(),
            sent_tx,
            sent_rx,
            max_width: opts.max_width,
            lay: Lay::default(),
            rows: Vec::new(),
            scroll: 0,
            followed: None,
            press: None,
            last_press: None,
            block: None,
            published: None,
            live: true,
            would_send: None,
            would_copy: None,
        }
    }

    /// The configuration ⏎ starts.
    pub fn agent(&self) -> &Agent {
        &self.agents[self.agent]
    }

    /// `a` as it starts: on the Claude profile o is on (`claude(opus)·2`,
    /// with its CLAUDE_CONFIG_DIR).
    fn launch(&self, a: &Agent) -> Agent {
        a.on(self.profiles.get(self.profile))
    }

    /// What's left of the text on its first row: the configuration ⏎
    /// starts, then `>` (`◇` in a draft): `claude(opus) >`. A reply, which
    /// goes to an agent already running, is `◇` only; so is a terminal
    /// too narrow for the name.
    pub fn prefix(&self) -> String {
        self.prefix_at(self.lay.width)
    }

    fn prefix_at(&self, width: u16) -> String {
        let glyph = if self.editing.is_some() { "◇" } else { ">" };
        let name = &self.launch(self.agent()).name;
        let reply = self.editing.as_ref().is_some_and(|d| d.reply.is_some());
        if reply || (width as usize) < name.width() + 4 + NAMED_MIN_TEXT {
            return glyph.to_string();
        }
        format!("{name} {glyph}")
    }

    pub fn toast(&mut self, m: impl Into<String>, ok: bool) {
        self.toast = Some((m.into(), ok, Instant::now()));
    }

    // ---- layout ------------------------------------------------------------

    /// The columns o draws in on a terminal `w` wide: at most `max_width`,
    /// from the left, so a wide pane doesn't stretch the text across it.
    pub fn cap(&self, w: u16) -> u16 {
        if self.max_width == 0 {
            w
        } else {
            w.min(self.max_width)
        }
    }

    /// The columns the text wraps to on a terminal `w` wide: less the
    /// `claude(opus) > ` gutter, a column for the cursor past a full row, and
    /// the last column, left alone (writing there leaves the terminal
    /// waiting to wrap).
    fn text_width(&self, w: u16) -> usize {
        let gutter = self.prefix_at(w).width() + 1;
        (w as usize).saturating_sub(gutter + 2).max(4)
    }

    /// Lay the prompt out for a `width`×`screen_h` terminal: its text's rows,
    /// as many as there are up to the screen, scrolled to keep the cursor in
    /// view; under them a toast and what's starting, when there are. All of
    /// it in the terminal's first `cap(width)` columns.
    pub fn layout(&mut self, width: u16, screen_h: u16) {
        let width = self.cap(width);
        let tw = self.text_width(width);
        let starting = self.sent.iter().filter(|s| s.outcome.is_none()).count();
        let extra = usize::from(self.toast.is_some()) + starting;
        // A line of what was there before stays in view.
        let room = (screen_h as usize).saturating_sub(extra + 1).max(1);
        if self.drafts.is_empty() {
            self.list = None;
        }
        self.pictures = Strip::default();
        if let Some(sel) = self.list {
            let sel = sel.min(self.drafts.len() - 1);
            self.list = Some(sel);
            self.marked.retain(|id| self.drafts.iter().any(|d| &d.id == id));
            // The list has no name on the left: its text is as wide as `> `'s.
            let tw = (width as usize).saturating_sub(4).max(4);
            // The selected draft's images on top. The room is kept while
            // any draft has one, so the list stays put as the selection
            // moves; it's the first thing to go on a short screen.
            let strip = (IMG_ROWS + 1).min(room.saturating_sub(self.drafts.len().min(LIST_ROWS) + 2));
            let pictures = self.gfx.is_some() && self.drafts.iter().any(|d| !drafts::tagged(&d.text, &d.images).is_empty());
            let strip = if pictures && strip >= 4 { strip } else { 0 };
            let room = room - strip;
            // The drafts, the selected one's text under them, and the keys.
            let shown = self.drafts.len().min(LIST_ROWS).min(room.saturating_sub(2).max(1));
            let mut top = self.view.top.min(self.drafts.len() - shown);
            if sel < top {
                top = sel;
            } else if sel >= top + shown {
                top = sel + 1 - shown;
            }
            let text = &self.drafts[sel].text;
            let rows = if text.trim().is_empty() { Vec::new() } else { field::word_rows(text, tw.saturating_sub(2).max(4)) };
            let fits = room.saturating_sub(shown + 1).min(PREVIEW_ROWS);
            // Too long: its last row here says how many more there are.
            let preview = if rows.len() > fits { fits.saturating_sub(1) } else { rows.len() };
            let more = rows.len() - preview;
            let (thumbs, note) = if strip > 0 { self.thumbs(sel, tw, strip - 1) } else { (Vec::new(), None) };
            let body = strip + shown + preview + usize::from(more > 0 && fits > 0) + 1;
            self.view = ListView { top, shown, rows, preview, more, strip, thumbs, note };
            self.rows.clear();
            self.lay = Lay { width, screen_h, text: Rect::new(2, 0, tw as u16, body as u16), height: (body + extra) as u16 };
            return;
        }
        if self.sent_at.is_some() {
            self.rows.clear();
            let body = room.min(3);
            self.lay = Lay { width, screen_h, text: Rect::new(2, 0, tw as u16, body as u16), height: (body + extra) as u16 };
            return;
        }
        self.rows = field::word_rows(&self.field.text, tw);
        // A draft's images over its text, staying there as it scrolls.
        self.pictures = self.draft_pictures(tw, room);
        let top = self.pictures.height;
        let view = self.rows.len().clamp(1, room - top);
        let gutter = self.prefix_at(width).width() as u16 + 1;
        let text = Rect::new(gutter, top as u16, tw as u16, view as u16);
        self.lay = Lay { width, screen_h, text, height: (top + view + extra) as u16 };
        self.follow(view, tw);
    }

    /// Something will change without a key: a send starting, a toast to
    /// take down. The loop wakes more often then.
    pub fn busy(&self) -> bool {
        self.toast.is_some() || self.sent.iter().any(|s| s.outcome.is_none()) || self.pics.values().any(Option::is_none)
    }

    /// The row the cursor is on.
    pub fn cursor_row(&self) -> usize {
        self.rows.iter().rposition(|r| r.start <= self.field.cur).unwrap_or(0)
    }

    /// Where the terminal's cursor goes, from the prompt's first line: on
    /// the cursor's cell, when its row is in view.
    pub fn cursor_cell(&self) -> Option<(u16, u16)> {
        if self.list.is_some() || self.sent_at.is_some() {
            return None;
        }
        let cr = self.cursor_row();
        let t = self.lay.text;
        if cr < self.scroll || cr >= self.scroll + t.height as usize {
            return None;
        }
        let x = t.x + self.field.text[self.rows[cr].start..self.field.cur].width() as u16;
        Some((x, t.y + (cr - self.scroll) as u16))
    }

    /// Keep the cursor's row in view when it moved or the text changed
    /// since last time.
    fn follow(&mut self, view: usize, tw: usize) {
        let now = (self.field.cur, self.field.text.len(), self.field.anchor, tw, view as u16);
        if self.followed != Some(now) {
            self.followed = Some(now);
            let cr = self.cursor_row();
            if cr < self.scroll {
                self.scroll = cr;
            } else if cr >= self.scroll + view {
                self.scroll = cr + 1 - view;
            }
        }
        self.scroll = self.scroll.min(self.rows.len().saturating_sub(view));
    }

    // ---- images ------------------------------------------------------------

    /// Draft `sel`'s images, side by side in `width` columns, each at most
    /// `rows` tall (its label under it), and what to say where there's no
    /// picture. The ones not readied yet start loading.
    fn thumbs(&mut self, sel: usize, width: usize, rows: usize) -> (Vec<Thumb>, Option<String>) {
        let Some(g) = self.gfx else { return (Vec::new(), None) };
        let d = &self.drafts[sel];
        let tagged = drafts::tagged(&d.text, &d.images);
        if tagged.is_empty() {
            return (Vec::new(), Some("no images".into()));
        }
        self.row_of_thumbs(g, tagged, width, rows..=rows, false)
    }

    /// The draft being written's images, over its text in `width` columns:
    /// all of them in a row, all EDIT_IMG_ROWS tall, or shorter when that's
    /// what it takes to fit them all across. The text keeps a few rows of
    /// `room` (its own, when it has fewer); none when there's no room for them.
    fn draft_pictures(&mut self, width: usize, room: usize) -> Strip {
        let Some(g) = self.gfx else { return Strip::default() };
        if self.editing.is_none() {
            return Strip::default();
        }
        let tagged = drafts::tagged(&self.field.text, &self.images);
        if tagged.is_empty() {
            return Strip::default();
        }
        let keep = self.rows.len().clamp(1, 4);
        let rows = EDIT_IMG_ROWS.min(room.saturating_sub(keep + 1));
        if rows < EDIT_IMG_MIN {
            return Strip::default();
        }
        let (thumbs, note) = self.row_of_thumbs(g, tagged, width, EDIT_IMG_MIN..=rows, true);
        let tallest = thumbs.iter().map(|t| t.rows as usize + 1).max().unwrap_or(0);
        Strip { height: tallest.max(usize::from(note.is_some())), thumbs, note }
    }

    /// `tagged`'s images side by side in `width` columns, a label under
    /// each: as tall as `rows` allows with every one of them in the row (the
    /// shortest, with as many as fit and `+N more`, when none does). Each
    /// keeps its shape: no bigger than itself, the last one squeezed into
    /// what's left; or, `even`, all exactly as tall. What to say where
    /// there's no picture comes too; the ones not readied yet start loading.
    fn row_of_thumbs(&mut self, g: Gfx, tagged: Vec<(usize, PathBuf)>, width: usize, rows: std::ops::RangeInclusive<usize>, even: bool) -> (Vec<Thumb>, Option<String>) {
        for (_, path) in &tagged {
            if !self.pics.contains_key(path) {
                self.load_pic(path.clone());
            }
        }
        let size = |p: &PathBuf| match self.pics.get(p) {
            Some(Some(Ok(pic))) => Some((pic.w, pic.h)),
            _ => None,
        };
        let label = |n: usize| format!("[Image #{n}]").len();
        // A picture's cells at `r` rows with `left` columns left; None when it doesn't fit.
        let cells = |w: u32, h: u32, left: usize, r: usize| -> Option<(u16, u16)> {
            if even {
                let c = gfx::cols_at(w, h, g, r);
                (usize::from(c) <= left).then_some((c, r as u16))
            } else {
                (left >= 6).then(|| gfx::fit(w, h, g, left, r))
            }
        };
        // The tallest that fits them all: the columns they take, the gaps between included.
        let across = |r: usize| -> usize {
            let slots = tagged.iter().filter_map(|(n, p)| size(p).map(|(w, h)| cells(w, h, usize::MAX, r).map_or(0, |c| usize::from(c.0)).max(label(*n))));
            slots.map(|c| c + 2).sum::<usize>().saturating_sub(2)
        };
        let rows = rows.clone().rev().find(|&r| across(r) <= width).unwrap_or(*rows.start());
        let (mut out, mut x, mut full) = (Vec::new(), 0usize, false);
        let (mut loading, mut more, mut failed) = (0, 0, Vec::new());
        for (n, path) in tagged {
            let state = self.pics.get(&path).map(|s| s.as_ref().map(|r| r.as_ref().map(|p| (p.w, p.h)).map_err(|_| ())));
            match state {
                None | Some(None) => loading += 1,
                Some(Some(Err(()))) => failed.push(n),
                Some(Some(Ok((w, h)))) => {
                    // The first that doesn't fit, and the ones after it, are `+N more`.
                    let fits = if full { None } else { cells(w, h, width.saturating_sub(x), rows) };
                    let Some((cols, r)) = fits else {
                        (full, more) = (true, more + 1);
                        continue;
                    };
                    let Some(Some(Ok(pic))) = self.pics.get(&path) else { continue };
                    let id = self.imgs.id_for((path.clone(), cols, r), &pic.b64);
                    out.push(Thumb { x: x as u16, id, cols, rows: r, n });
                    x += (cols as usize).max(label(n)) + 2;
                }
            }
        }
        let mut note = Vec::new();
        if loading > 0 {
            note.push("loading…".to_string());
        }
        if more > 0 {
            note.push(format!("+{more} more"));
        }
        if !failed.is_empty() {
            let tags: Vec<String> = failed.iter().map(|n| format!("[Image #{n}]")).collect();
            note.push(format!("couldn't show {}", tags.join(" ")));
        }
        (out, (!note.is_empty()).then(|| note.join(" · ")))
    }

    /// The draft's images were copied beside it (drafts::keep_images): what
    /// was readied for the terminal, and what it was sent, go under the
    /// copies' names, so the pictures stay put rather than load again.
    fn images_moved(&mut self, from: &[PathBuf], to: &[PathBuf]) {
        for (a, b) in from.iter().zip(to).filter(|(a, b)| a != b) {
            if let Some(pic) = self.pics.get(a).cloned() {
                self.pics.insert(b.clone(), pic);
            }
            for (key, _) in self.imgs.sent.iter_mut().filter(|(k, _)| &k.0 == a) {
                key.0 = b.clone();
            }
        }
    }

    /// Ready `path` for the terminal, off the UI thread (tick picks it up);
    /// --snapshot waits for it.
    fn load_pic(&mut self, path: PathBuf) {
        if !self.live {
            let pic = gfx::load_pic(&path);
            self.pics.insert(path, Some(pic));
            return;
        }
        self.pics.insert(path.clone(), None);
        let tx = self.pic_tx.clone();
        std::thread::spawn(move || {
            let pic = gfx::load_pic(&path);
            let _ = tx.send((path, pic));
        });
    }

    /// Bytes for the terminal (images to send or free), to write before the frame.
    pub fn take_gfx(&mut self) -> Vec<u8> {
        self.imgs.take()
    }

    /// Free every image o sent, for quitting.
    pub fn clear_images(&mut self) -> Vec<u8> {
        self.imgs.clear()
    }

    // ---- the loop's hooks --------------------------------------------------

    /// Sends finished, a toast gone: true when the screen changed.
    pub fn tick(&mut self) -> bool {
        let mut changed = false;
        while let Ok((n, out)) = self.sent_rx.try_recv() {
            if let Some(s) = self.sent.get_mut(n) {
                // ⌥⌘N in the agent's pane shows the images it was sent.
                if let (true, true, Some(block)) = (self.live, out.1, &out.2) {
                    if !s.images.is_empty() {
                        panes::write(block, panes::SENT, &s.images);
                    }
                }
                s.outcome = Some(out);
                self.done.push(n);
            }
            if self.focus_next == Some(n) {
                self.focus_sent(n);
            }
            changed = true;
        }
        while let Ok((path, pic)) = self.pic_rx.try_recv() {
            self.pics.insert(path, Some(pic));
            changed = true;
        }
        if self.toast.as_ref().is_some_and(|t| t.2.elapsed() > TOAST) {
            self.toast = None;
            changed = true;
        }
        changed
    }

    /// No key for a while (main.rs): the draft being written saved once the
    /// typing has paused, and the list brought up to date with the file
    /// (al may have changed it). True when the screen changed.
    pub fn idle(&mut self) -> bool {
        let toasted = self.toast.is_some();
        if self.last_key.elapsed() >= SAVE_AFTER {
            self.sync_draft();
        }
        let mut changed = self.toast.is_some() != toasted;
        if self.list.is_some() && self.live && drafts::stamp() != self.drafts_seen {
            let id = self.list.and_then(|i| self.drafts.get(i)).map(|d| d.id.clone());
            self.reload_drafts();
            self.select_draft(id.as_deref());
            if self.drafts.is_empty() {
                self.close_list();
            }
            changed = true;
        }
        changed
    }

    /// How long the loop may sleep: short while something changes on its
    /// own, or a draft waits to be saved.
    pub fn wait(&self) -> Duration {
        if self.busy() {
            Duration::from_millis(50)
        } else if self.unsaved() {
            SAVE_AFTER
        } else {
            Duration::from_secs(1)
        }
    }

    /// The images ⌥⌘N shows over this pane now: the selected draft's in
    /// the list, else the ones the prompt tags.
    pub fn showing(&self) -> Tagged {
        match self.list.and_then(|i| self.drafts.get(i)) {
            Some(d) => drafts::tagged(&d.text, &d.images),
            None => drafts::tagged(&self.field.text, &self.images),
        }
    }

    /// Keep this pane's images (panes.rs) as `showing` has them, when they
    /// changed. main.rs calls it each time round.
    pub fn publish(&mut self) {
        let Some(block) = self.block.clone() else { return };
        let now = self.showing();
        if self.published.as_ref() != Some(&now) {
            panes::write(&block, panes::PROMPT, &now);
            self.published = Some(now);
        }
    }

    /// Quitting: none here any more.
    pub fn unpublish(&mut self) {
        if let Some(block) = &self.block {
            panes::write(block, panes::PROMPT, &[]);
        }
    }

    /// Leaving o: the draft being written saved (an empty one dropped).
    pub fn flush(&mut self) {
        let Some(d) = self.editing.clone() else { return };
        if self.field.text.trim().is_empty() {
            self.drop_draft(&d.id);
        } else {
            self.sync_draft();
        }
    }

    /// The sends that finished since last time, to print above the prompt.
    pub fn take_done(&mut self) -> Vec<usize> {
        std::mem::take(&mut self.done)
    }

    // ---- events ------------------------------------------------------------

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
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let alt = k.modifiers.contains(KeyModifiers::ALT);
        let shift = k.modifiers.contains(KeyModifiers::SHIFT);
        let sup = k.modifiers.contains(KeyModifiers::SUPER);
        if k.code != KeyCode::Esc {
            self.esc_at = None;
        }
        self.last_key = Instant::now();
        if self.list.is_some() {
            return self.list_key(k);
        }
        if let Some(sel) = self.sent_at {
            match k.code {
                KeyCode::Up if !shift && !alt && !ctrl && !sup => self.sent_at = Some(sel.saturating_sub(1)),
                KeyCode::Down if !shift && !alt && !ctrl && !sup => {
                    self.sent_at = if sel + 1 < self.sent.len() { Some(sel + 1) } else { None };
                }
                KeyCode::Enter if !shift && !alt => self.focus_sent(sel),
                KeyCode::Esc => self.sent_at = None,
                _ => { self.sent_at = None; return self.key(k); }
            }
            return Act::None;
        }
        match k.code {
            KeyCode::Up if k.modifiers.is_empty() && self.field.text.is_empty() && self.editing.is_none() && !self.sent.is_empty() => {
                self.sent_at = Some(self.sent.len() - 1);
            }
            // Esc drops a selection, then (twice) clears the prompt, then quits.
            // Out of a draft it just leaves: the draft stays, as saved.
            KeyCode::Esc if self.field.selection().is_some() => self.field.anchor = None,
            KeyCode::Esc if self.editing.is_some() => self.leave_draft(),
            KeyCode::Esc if self.field.text.is_empty() => return Act::Quit,
            KeyCode::Esc if self.esc_at.is_some_and(|t| t.elapsed() < ESC_AGAIN) => {
                self.esc_at = None;
                self.clear_box("cleared · ^z brings it back");
            }
            KeyCode::Esc => {
                self.esc_at = Some(Instant::now());
                self.toast("esc again to clear", true);
            }
            // ^c copies the selection (⌘c is Ghostty's own); with none it
            // clears the prompt, and on an empty one it quits. ^x cuts, ^z
            // brings back what was cleared (or sent).
            KeyCode::Char('c') if ctrl => return self.ctrl_c(),
            // ⌥c copies the text alone: the selection's, else the prompt's,
            // without its image tags or extra spaces and blank lines.
            KeyCode::Char('c') if alt => {
                let text = self.field.selected().unwrap_or(&self.field.text).to_string();
                self.copy_plain(&text);
            }
            KeyCode::Char('d') if ctrl && self.field.text.is_empty() && self.editing.is_some() => self.leave_draft(),
            KeyCode::Char('d') if ctrl && self.field.text.is_empty() => return Act::Quit,
            // ^s keeps the prompt as a draft; ^g goes through the drafts.
            KeyCode::Char('s') if ctrl => self.keep_as_draft(),
            KeyCode::Char('g') if ctrl => self.open_list(),
            KeyCode::Char('x') if ctrl => self.cut(),
            KeyCode::Char('z') if ctrl => self.unclear(),
            // Newline: shift+Enter (the kitty keyboard protocol tells it from
            // Enter; see main.rs), alt+Enter, or ^j anywhere.
            KeyCode::Enter if alt || shift => self.field.insert("\n"),
            KeyCode::Char('j') if ctrl => self.field.insert("\n"),
            // ^⏎ or ^o: send it, and go to its tab.
            KeyCode::Enter if ctrl => self.send(true),
            KeyCode::Char('o') if ctrl => self.send(true),
            KeyCode::Enter => self.send(false),
            // ⇧tab: the next configuration (round to the first after the
            // last); ^1…^9 the Nth, as config.toml lists them. ^digits come
            // as themselves through the kitty keyboard protocol (main.rs).
            KeyCode::BackTab => self.pick_agent(self.agent + 1),
            KeyCode::Tab if shift => self.pick_agent(self.agent + 1),
            KeyCode::Char(c @ '1'..='9') if ctrl && !alt => {
                let n = c as usize - '1' as usize;
                if n < self.agents.len() {
                    self.pick_agent(n);
                } else {
                    self.toast(format!("there's no configuration {} · o --config lists them", n + 1), false);
                }
            }
            // ^n: the next Claude profile (account), round to the main one.
            KeyCode::Char('n') if ctrl => self.next_profile(),
            KeyCode::Char('p') if ctrl => {
                self.plan = !self.plan;
                self.toast(if self.plan { "plan mode: sends `/plan …`" } else { "plan mode off" }, true);
            }
            KeyCode::Char('v') if ctrl => self.paste_image(),
            // ^l: as in a shell, the screen cleared and the prompt at its
            // top, what's written kept.
            KeyCode::Char('l') if ctrl => return Act::ClearScreen,
            // ^y: what ^u ^k ^w ⌥d ⌥⌫ deleted last, back at the cursor.
            KeyCode::Char('y') if ctrl => {
                let k = self.killed.clone();
                self.field.insert(&k);
            }
            // ↑↓: a row up or down, as the prompt wraps the text; from its
            // first row ↑ goes back through what was sent (from its last,
            // ↓ comes forward again), as a shell's history does. ⇧↑ ⇧↓
            // select along. (⌥↑ ⌥↓ go by line, ⌘↑ ⌘↓ to the text's ends:
            // Field::key.)
            KeyCode::Up | KeyCode::Down if !alt && !sup => {
                let up = k.code == KeyCode::Up;
                let rows = field::word_rows(&self.field.text, self.text_width(self.lay.width));
                let row = rows.iter().rposition(|r| r.start <= self.field.cur).unwrap_or(0);
                let edge = if up { row == 0 } else { row + 1 == rows.len() };
                // (Not in a draft: what's recalled would be saved over it.)
                let recalled = !shift && edge && self.editing.is_none() && if up { self.history_back() } else { self.history_forward() };
                if !recalled {
                    self.field.vertical_by(&rows, if up { -1 } else { 1 }, shift);
                }
            }
            // The deleting keys keep what they deleted, for ^y.
            KeyCode::Char('u' | 'k' | 'w') if ctrl => self.kill(&k),
            KeyCode::Char('d' | 'D') if alt => self.kill(&k),
            KeyCode::Backspace if alt => self.kill(&k),
            _ => {
                self.field.key(&k);
            }
        }
        Act::None
    }

    /// A deleting key: what it took (from where the cursor lands, as long
    /// as the text got shorter) kept for ^y.
    fn kill(&mut self, k: &KeyEvent) {
        let before = self.field.text.clone();
        self.field.key(k);
        let n = before.len() - self.field.text.len();
        if n > 0 {
            let at = self.field.cur;
            self.killed = before[at..at + n].to_string();
        }
    }

    // ---- history -----------------------------------------------------------

    /// ↑ on the first row: the sent prompt before the one shown (the prompt
    /// being written kept aside). False when there's none further back.
    fn history_back(&mut self) -> bool {
        let to = self.hist_at.map_or(0, |i| i + 1);
        let live = self.live;
        let all = self.history.get_or_insert_with(|| if live { load_history() } else { Vec::new() });
        let Some((text, images)) = all.iter().rev().nth(to).cloned() else { return false };
        if self.hist_at.is_none() {
            self.draft = Some((std::mem::take(&mut self.field), std::mem::take(&mut self.images)));
        }
        self.hist_at = Some(to);
        self.show(text, images);
        true
    }

    /// ↓ on the last row: the next newer prompt, or past the newest the one
    /// being written. False when not going through them.
    fn history_forward(&mut self) -> bool {
        let Some(i) = self.hist_at else { return false };
        if i == 0 {
            self.hist_at = None;
            let (f, images) = self.draft.take().unwrap_or_default();
            (self.field, self.images) = (f, images);
            self.field.end();
            return true;
        }
        let Some((text, images)) = self.history.as_ref().and_then(|h| h.iter().rev().nth(i - 1)).cloned() else { return false };
        self.hist_at = Some(i - 1);
        self.show(text, images);
        true
    }

    fn show(&mut self, text: String, images: Vec<PathBuf>) {
        self.field = Field { text, ..Default::default() };
        self.field.end();
        self.images = images;
    }

    /// A sent prompt, into the history (and its file), unless it's the
    /// newest already.
    fn remember(&mut self, text: &str, images: &[PathBuf]) {
        self.hist_at = None;
        self.draft = None;
        let live = self.live;
        let all = self.history.get_or_insert_with(|| if live { load_history() } else { Vec::new() });
        if all.last().is_some_and(|(t, i)| t == text && i == images) {
            return;
        }
        all.push((text.to_string(), images.to_vec()));
        if all.len() > HISTORY {
            all.drain(..all.len() - HISTORY);
        }
        if live {
            append_history(text, images);
        }
    }

    /// Configuration `n` (round the list) is what ⏎ starts, and where o
    /// starts next time (config.rs). The prompt's name says so; no toast.
    fn pick_agent(&mut self, n: usize) {
        if self.editing.as_ref().is_some_and(|d| d.reply.is_some()) {
            return self.toast("a reply goes to the agent it answers", false);
        }
        let n = n % self.agents.len();
        if n != self.agent && self.live {
            crate::config::remember(&self.agents[n].name);
        }
        self.agent = n;
    }

    /// ^n: the next Claude profile (round to the main one) is the one the
    /// claude configurations start on, and where o starts next time. The
    /// toast says which, and its limits as its status line last saw them.
    fn next_profile(&mut self) {
        if self.editing.as_ref().is_some_and(|d| d.reply.is_some()) {
            return self.toast("a reply goes to the agent it answers", false);
        }
        if self.profiles.len() < 2 {
            return self.toast("one Claude profile here (~/.claude) · a ~/.claude-NAME folder Claude Code ran in is another", false);
        }
        self.profile = (self.profile + 1) % self.profiles.len();
        let p = &self.profiles[self.profile];
        if self.live {
            crate::config::remember_profile(&p.name);
        }
        let usage = if self.live { p.usage() } else { None };
        let usage = usage.map(|u| format!(" · {u}")).unwrap_or_default();
        let only = if self.agent().kind == "claude" { "" } else { " · for the claude configurations" };
        let msg = format!("Claude profile {} ({}){usage}{only}", p.name, crate::config::shorten(&p.dir));
        self.toast(msg, true);
    }

    /// Which configuration draft `d` starts: the one it names, else the
    /// first of its kind. None when neither is configured.
    fn agent_of(&self, d: &Draft) -> Option<usize> {
        let by_name = d.config.as_ref().and_then(|n| self.agents.iter().position(|a| &a.name == n));
        by_name.or_else(|| d.kind.as_ref().and_then(|k| self.agents.iter().position(|a| &a.kind == k)))
    }

    /// The name of the configuration draft `d` starts, for the list.
    pub fn draft_agent(&self, d: &Draft) -> Option<&str> {
        self.agent_of(d).map(|i| self.agents[i].name.as_str())
    }

    /// ⏎ on a send: go to its agent's tab. One still starting is gone to as
    /// soon as its tab exists (tick); the latest ⏎ wins.
    fn focus_sent(&mut self, index: usize) {
        self.focus_next = None;
        let Some(sent) = self.sent.get(index) else { return };
        // The target is a block ID; the toast names it as the send did (`tab …`).
        let (target, shown) = match &sent.outcome {
            None => {
                self.focus_next = Some(index);
                return self.toast("focusing its tab as soon as it opens…", true);
            }
            Some((msg, true, Some(target))) => (target.clone(), msg.trim_start_matches("→ ").to_string()),
            _ => return self.toast("this send has no agent to focus", false),
        };
        let result = if self.live { spawn::focus(&target) } else { Ok(()) };
        match result {
            Ok(()) => self.toast(format!("focused {shown}"), true),
            Err(e) => self.toast(format!("couldn't focus agent: {e}"), false),
        }
    }

    /// ⏎: start the agent with the prompt in a new tab (`focus`: and go
    /// there). The prompt empties for the next one; ^z brings this one back.
    fn send(&mut self, focus: bool) {
        let text = self.field.text.trim().to_string();
        if text.is_empty() {
            return self.toast("nothing to send yet", false);
        }
        if let Some(d) = self.current() {
            // A draft: off from its own folder (or to the agent it answers),
            // and it goes.
            let images = self.images.clone();
            if self.dispatch(&d, &text, &images, focus) {
                self.cleared = Some((std::mem::take(&mut self.field), std::mem::take(&mut self.images)));
                self.unbind(&d.id);
            }
            return;
        }
        let body = field::with_images(&text, &self.images);
        let prompt = if self.plan { format!("/plan {body}") } else { body };
        let images = self.images.clone();
        self.remember(&text, &images);
        let agent = self.launch(self.agent());
        let n = self.sent.len();
        let tagged = drafts::tagged(&text, &images);
        self.sent.push(Sent { name: agent.name.clone(), text: text.clone(), plan: self.plan, outcome: None, images: tagged });
        if self.live {
            spawn::send(n, &agent, &prompt, &self.cwd, &self.label, focus, self.sent_tx.clone());
        } else {
            // --snapshot: as if it started.
            self.would_send = Some(prompt);
            let _ = self.sent_tx.send((n, (format!("→ tab {}", if focus { "snapshot (went there)" } else { "snapshot" }), true, Some(format!("snapshot-{n}")))));
        }
        // A note's name labels the tab it went to, not the ones after.
        self.label.clear();
        self.cleared = Some((std::mem::take(&mut self.field), std::mem::take(&mut self.images)));
        self.scroll = 0;
    }

    // ---- drafts ------------------------------------------------------------

    /// This Rex session: its id and name, asked for once.
    fn scope(&mut self) -> (String, String) {
        let live = self.live;
        self.scope
            .get_or_insert_with(|| if live { spawn::space() } else { (std::env::var("REX_SESSION").unwrap_or_default(), String::new()) })
            .clone()
    }

    /// This session's drafts from the file, when it changed (another o may have
    /// written it). --snapshot keeps its own, in memory.
    fn reload_drafts(&mut self) {
        if !self.live {
            return;
        }
        let stamp = drafts::stamp();
        if stamp.is_some() && stamp == self.drafts_seen {
            return;
        }
        let (ws, space) = self.scope();
        self.drafts_seen = stamp;
        self.drafts = drafts::load().into_iter().filter(|d| d.belongs(&ws, &space)).collect();
    }

    /// Save `d` (a new one on top), in the file too unless --snapshot.
    fn store_draft(&mut self, d: Draft) -> bool {
        if self.live {
            if let Err(e) = drafts::put(&d) {
                self.toast(format!("couldn't save the draft: {e}"), false);
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
    fn drop_draft(&mut self, id: &str) -> bool {
        self.drop_drafts(&[id])
    }

    /// Take drafts `ids` out, in one write.
    fn drop_drafts(&mut self, ids: &[&str]) -> bool {
        if self.live {
            if let Err(e) = drafts::remove(ids) {
                self.toast(format!("couldn't delete the draft: {e}"), false);
                return false;
            }
        }
        self.drafts.retain(|d| !ids.contains(&d.id.as_str()));
        true
    }

    /// The list's selection on draft `id` (where it was, when it's gone).
    fn select_draft(&mut self, id: Option<&str>) {
        if let Some(sel) = self.list.as_mut() {
            if let Some(i) = id.and_then(|id| self.drafts.iter().position(|d| d.id == id)) {
                *sel = i;
            }
            *sel = (*sel).min(self.drafts.len().saturating_sub(1));
        }
    }

    /// The draft being written as the prompt has it now: its text, images,
    /// configuration and plan mode.
    fn current(&self) -> Option<Draft> {
        let d = self.editing.as_ref()?;
        // A reply has no agent of its own to start.
        let (kind, config) = if d.reply.is_some() {
            (d.kind.clone(), d.config.clone())
        } else {
            (Some(self.agent().kind.clone()), Some(self.agent().name.clone()))
        };
        Some(Draft { text: self.field.text.clone(), images: self.images.clone(), kind, config, plan: self.plan, ..d.clone() })
    }

    /// Whether the draft being written has changes not saved yet.
    fn unsaved(&self) -> bool {
        self.current() != self.editing
    }

    /// The draft being written, saved if it changed; its new images copied
    /// beside it.
    fn sync_draft(&mut self) {
        let Some(mut d) = self.current() else { return };
        if Some(&d) == self.editing.as_ref() {
            return;
        }
        if self.live {
            d.images = drafts::keep_images(&d.id, &d.text, &d.images);
            let before = std::mem::replace(&mut self.images, d.images.clone());
            self.images_moved(&before, &d.images);
        }
        // Saved or not, don't try again until it changes again.
        self.editing = Some(d.clone());
        self.store_draft(d);
    }

    /// ^s: the prompt becomes a draft, saved as it's written from now on.
    fn keep_as_draft(&mut self) {
        if self.editing.is_some() {
            self.sync_draft();
            return self.toast("it's a draft already: saved as you type · esc keeps it for later", true);
        }
        if self.field.text.trim().is_empty() {
            return self.toast("nothing written to keep yet", false);
        }
        self.reload_drafts();
        let (workspace, space) = self.scope();
        let id = drafts::new_id();
        let text = self.field.text.clone();
        let images = if self.live { drafts::keep_images(&id, &text, &self.images) } else { self.images.clone() };
        let (cwd, plan) = (self.cwd.clone(), self.plan);
        let (kind, config) = (Some(self.agent().kind.clone()), Some(self.agent().name.clone()));
        let d = Draft { id, workspace, space, cwd, text, images: images.clone(), created: drafts::now(), reply: None, kind, config, plan };
        if !self.store_draft(d.clone()) {
            return;
        }
        let before = std::mem::replace(&mut self.images, images);
        self.images_moved(&before, &self.images.clone());
        self.editing = Some(d);
        self.from_list = false;
        self.hist_at = None;
        self.draft = None;
        self.toast("saved as a draft · esc keeps it for later · ^g goes through them", true);
    }

    /// ^g: go through this session's drafts.
    fn open_list(&mut self) {
        self.sync_draft();
        self.drafts_seen = None;
        self.reload_drafts();
        if self.drafts.is_empty() {
            return self.toast("no drafts in this session yet · ^s keeps the prompt as one", false);
        }
        let at = self.editing.as_ref().and_then(|e| self.drafts.iter().position(|d| d.id == e.id));
        self.list = Some(at.unwrap_or(0));
        self.view = ListView::default();
        self.toast = None;
    }

    /// Out of the list, back to the prompt as it was.
    fn close_list(&mut self) {
        self.list = None;
        (self.marked, self.mark_from) = (Vec::new(), None);
        if self.editing.is_none() {
            self.restore_aside();
        }
    }

    /// The prompt set aside for a draft, back (when there's one).
    fn restore_aside(&mut self) {
        if let Some((f, images, agent, plan)) = self.aside.take() {
            (self.field, self.images, self.agent, self.plan) = (f, images, agent, plan);
        }
    }

    /// Write draft `d` in the prompt. What was being written there is set
    /// aside (a draft: saved and left).
    fn edit_draft(&mut self, d: Draft, from_list: bool) {
        self.list = None;
        if self.editing.as_ref().is_some_and(|e| e.id == d.id) {
            return;
        }
        if let Some(e) = self.editing.take() {
            self.editing = Some(e.clone());
            if self.field.text.trim().is_empty() {
                self.drop_draft(&e.id);
            } else {
                self.sync_draft();
            }
        } else if self.aside.is_none() && !self.field.text.trim().is_empty() {
            self.aside = Some((std::mem::take(&mut self.field), std::mem::take(&mut self.images), self.agent, self.plan));
        }
        self.show(d.text.clone(), d.images.clone());
        if let Some(i) = self.agent_of(&d) {
            self.agent = i;
        }
        self.plan = d.plan;
        (self.hist_at, self.draft, self.cleared, self.scroll) = (None, None, None, 0);
        self.from_list = from_list;
        let what = match &d.reply {
            Some(r) => format!("a reply to {}", r.label),
            None => "a draft".to_string(),
        };
        self.toast(format!("{what}: saved as you type · ⏎ sends it · esc keeps it for later"), true);
        self.editing = Some(d);
    }

    /// Esc (or ^c on an empty prompt) out of a draft: it stays, as saved.
    /// One left empty goes.
    fn leave_draft(&mut self) {
        let Some(d) = self.editing.clone() else { return };
        if self.field.text.trim().is_empty() {
            if !self.drop_draft(&d.id) {
                return;
            }
            self.toast("dropped the empty draft", true);
        } else {
            self.sync_draft();
            self.toast("kept the draft · ^g goes through them", true);
        }
        self.unbind(&d.id);
    }

    /// The prompt lets go of draft `id` (left, or sent): back to the list
    /// when it was opened from there, else to what was being written before.
    fn unbind(&mut self, id: &str) {
        self.editing = None;
        (self.field, self.plan, self.scroll) = (Field::default(), false, 0);
        self.images.clear();
        if std::mem::take(&mut self.from_list) && !self.drafts.is_empty() {
            self.list = Some(0);
            self.select_draft(Some(id));
            self.view = ListView::default();
        } else {
            self.restore_aside();
        }
    }

    /// Send draft `d` as `text` and `images`: to the agent it replies to,
    /// else to a new agent in its folder; and the draft goes. A reply whose
    /// agent is gone stays, saying so. True when it went.
    fn dispatch(&mut self, d: &Draft, text: &str, images: &[PathBuf], focus: bool) -> bool {
        let to = match &d.reply {
            None => None,
            Some(r) => {
                let pane = if self.live { spawn::agent_pane(&r.pane, r.session.as_deref()) } else { Some(r.pane.clone()) };
                let Some(pane) = pane else {
                    self.toast(format!("no agent in {} any more · the reply stays", r.label), false);
                    return false;
                };
                Some((pane, r.label.clone()))
            }
        };
        let body = field::with_images(text, images);
        let prompt = if d.plan { format!("/plan {body}") } else { body };
        if !self.drop_draft(&d.id) {
            return false;
        }
        self.remember(text, images);
        let n = self.sent.len();
        let done = |m: &str| (format!("→ {m}"), true, Some(format!("snapshot-{n}")));
        match to {
            Some((pane, label)) => {
                self.sent.push(Sent { name: format!("↳{label}"), text: text.to_string(), plan: d.plan, outcome: None, images: drafts::tagged(text, images) });
                if self.live {
                    spawn::reply(n, &pane, &prompt, self.sent_tx.clone());
                } else {
                    self.would_send = Some(format!("[to {label} {pane}] {prompt}"));
                    let _ = self.sent_tx.send((n, done("pane snapshot")));
                }
            }
            None => {
                let agent = self.launch(&self.agents[self.agent_of(d).unwrap_or(0)]);
                self.sent.push(Sent { name: agent.name.clone(), text: text.to_string(), plan: d.plan, outcome: None, images: drafts::tagged(text, images) });
                if self.live {
                    spawn::send(n, &agent, &prompt, &d.cwd, "", focus, self.sent_tx.clone());
                } else {
                    self.would_send = Some(prompt);
                    let _ = self.sent_tx.send((n, done(if focus { "tab snapshot (went there)" } else { "tab snapshot" })));
                }
            }
        }
        true
    }

    /// A key in the drafts list: al's, and marks: ⇧↑ ⇧↓ (J K) mark as they
    /// go, space one, a all; with some marked, ⏎ sends them as one prompt
    /// and x deletes them.
    fn list_key(&mut self, k: KeyEvent) -> Act {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let alt = k.modifiers.contains(KeyModifiers::ALT);
        let shift = k.modifiers.contains(KeyModifiers::SHIFT);
        let Some(sel) = self.list else { return Act::None };
        let last = self.drafts.len().saturating_sub(1);
        let Some(d) = self.drafts.get(sel.min(last)).cloned() else {
            self.close_list();
            return Act::None;
        };
        // The one being written is as the prompt has it, saved or not yet.
        let d = self.current().filter(|c| c.id == d.id).unwrap_or(d);
        let run = match k.code {
            KeyCode::Down if shift => Some((sel + 1).min(last)),
            KeyCode::Up if shift => Some(sel.saturating_sub(1)),
            KeyCode::Char('J') => Some((sel + 1).min(last)),
            KeyCode::Char('K') => Some(sel.saturating_sub(1)),
            _ => None,
        };
        if let Some(to) = run {
            self.mark_run(sel, to);
            return Act::None;
        }
        // Any other key ends a run: what it marked stays marked.
        self.mark_from = None;
        let marked = !self.marked.is_empty();
        match k.code {
            // Esc unmarks first, then leaves.
            KeyCode::Esc if marked => self.marked.clear(),
            KeyCode::Esc | KeyCode::Char('q') => self.close_list(),
            KeyCode::Char(' ') => match self.marked.iter().position(|m| *m == d.id) {
                Some(i) => {
                    self.marked.remove(i);
                }
                None => self.marked.push(d.id.clone()),
            },
            KeyCode::Char('a') if self.marked.len() == self.drafts.len() => self.marked.clear(),
            KeyCode::Char('a') => self.marked = self.drafts.iter().map(|d| d.id.clone()).collect(),
            KeyCode::Enter | KeyCode::Char('o') if marked => self.send_marked(ctrl),
            KeyCode::Char('x' | ';') if marked => self.delete_marked(),
            KeyCode::Char('c' | 'g' | 'd') if ctrl => self.close_list(),
            // ⌥c: the selected draft's text alone, as the prompt's.
            KeyCode::Char('c') if alt => self.copy_plain(&d.text),
            KeyCode::Char('l') if ctrl => return Act::ClearScreen,
            KeyCode::Char('n') if ctrl => self.list = Some((sel + 1).min(last)),
            KeyCode::Char('p') if ctrl => self.list = Some(sel.saturating_sub(1)),
            KeyCode::Char('j') | KeyCode::Down => self.list = Some((sel + 1).min(last)),
            KeyCode::Char('k') | KeyCode::Up => self.list = Some(sel.saturating_sub(1)),
            KeyCode::Char('g') | KeyCode::Home => self.list = Some(0),
            KeyCode::Char('G') | KeyCode::End => self.list = Some(last),
            // ⏎ sends it (^⏎ or ^o: and goes to its tab), and it goes.
            KeyCode::Enter | KeyCode::Char('o') => {
                if d.text.trim().is_empty() {
                    self.toast("the draft is empty · e writes in it", false);
                } else if self.dispatch(&d, d.text.trim(), &d.images, ctrl) {
                    self.forget(&d.id);
                }
            }
            KeyCode::Char('e' | 'l' | 'r') => self.edit_draft(d, true),
            KeyCode::Char('x' | ';') => {
                if self.drop_draft(&d.id) {
                    self.forget(&d.id);
                    self.undo = vec![d];
                    self.toast("deleted the draft · u brings it back", true);
                }
            }
            KeyCode::Char('u') => self.undelete(),
            // A new one, empty, to write, on the configuration the prompt is on.
            KeyCode::Char('d') => {
                let (workspace, space) = self.scope();
                let (cwd, kind, config) = (self.cwd.clone(), Some(self.agent().kind.clone()), Some(self.agent().name.clone()));
                let d = Draft {
                    id: drafts::new_id(),
                    workspace,
                    space,
                    cwd,
                    text: String::new(),
                    images: Vec::new(),
                    created: drafts::now(),
                    reply: None,
                    kind,
                    config,
                    plan: false,
                };
                if self.store_draft(d.clone()) {
                    self.edit_draft(d, true);
                }
            }
            _ => {}
        }
        Act::None
    }

    /// ⇧↑ ⇧↓ from draft `sel` to `to`: the drafts from where the run
    /// started to `to` marked, on top of what was marked before it (so
    /// going back over the run unmarks what it marked).
    fn mark_run(&mut self, sel: usize, to: usize) {
        let (from, mut marked) = self.mark_from.get_or_insert_with(|| (sel, self.marked.clone())).clone();
        let (a, b) = (from.min(to), from.max(to));
        for d in self.drafts.get(a..=b).unwrap_or_default() {
            if !marked.contains(&d.id) {
                marked.push(d.id.clone());
            }
        }
        self.marked = marked;
        self.list = Some(to);
    }

    /// The marked drafts, in the list's order (the one being written as the
    /// prompt has it).
    fn marked_drafts(&self) -> Vec<Draft> {
        let cur = self.current();
        let pick = |d: &Draft| cur.clone().filter(|c| c.id == d.id).unwrap_or_else(|| d.clone());
        self.drafts.iter().filter(|d| self.marked.contains(&d.id)).map(pick).collect()
    }

    /// ⏎ with drafts marked: one alone goes as itself, more as one prompt
    /// (`send_all`). Empty ones are left out (and left).
    fn send_marked(&mut self, focus: bool) {
        let ds: Vec<Draft> = self.marked_drafts().into_iter().filter(|d| !d.text.trim().is_empty()).collect();
        match ds.as_slice() {
            [] => self.toast("the marked drafts are empty", false),
            [d] => {
                if self.dispatch(d, d.text.trim(), &d.images, focus) {
                    self.marked.clear();
                    self.forget(&d.id);
                }
            }
            _ if ds.iter().any(|d| d.reply.is_some()) => {
                self.toast("a reply goes to its own agent, not with others · space unmarks it", false);
            }
            _ => self.send_all(&ds, focus),
        }
    }

    /// Drafts `ds` as one prompt (drafts::combine) to one new agent, in the
    /// first one's folder and on its configuration, in plan mode when any
    /// of them is; and they all go.
    fn send_all(&mut self, ds: &[Draft], focus: bool) {
        let first = &ds[0];
        let agent = self.launch(&self.agents[self.agent_of(first).unwrap_or(0)]);
        let plan = ds.iter().any(|d| d.plan);
        let (text, images) = drafts::combine(ds);
        let ids: Vec<&str> = ds.iter().map(|d| d.id.as_str()).collect();
        if !self.drop_drafts(&ids) {
            return;
        }
        let body = field::with_images(&text, &images);
        let prompt = if plan { format!("/plan {body}") } else { body };
        // ↑ brings back the whole of it, to send again.
        self.remember(&text, &images);
        let n = self.sent.len();
        self.sent.push(Sent { name: agent.name.clone(), text: drafts::summary(ds), plan, outcome: None, images: drafts::tagged(&text, &images) });
        if self.live {
            spawn::send(n, &agent, &prompt, &first.cwd, "", focus, self.sent_tx.clone());
        } else {
            self.would_send = Some(prompt);
            let to = if focus { "→ tab snapshot (went there)" } else { "→ tab snapshot" };
            let _ = self.sent_tx.send((n, (to.to_string(), true, Some(format!("snapshot-{n}")))));
        }
        self.marked.clear();
        for d in ds {
            self.forget(&d.id);
        }
        self.toast(format!("sent {} drafts as one prompt to {}", ds.len(), agent.name), true);
    }

    /// x with drafts marked: they all go (u brings them back).
    fn delete_marked(&mut self) {
        let ds = self.marked_drafts();
        let ids: Vec<&str> = ds.iter().map(|d| d.id.as_str()).collect();
        if !self.drop_drafts(&ids) {
            return;
        }
        self.marked.clear();
        for d in &ds {
            self.forget(&d.id);
        }
        let n = ds.len();
        self.undo = ds;
        if n == 1 {
            self.toast("deleted the draft · u brings it back", true);
        } else {
            self.toast(format!("deleted {n} drafts · u brings them back"), true);
        }
    }

    /// u: the drafts x deleted last, back where they were in the list.
    fn undelete(&mut self) {
        let back = std::mem::take(&mut self.undo);
        let Some(id) = back.first().map(|d| d.id.clone()) else {
            return self.toast("no deleted draft to bring back", false);
        };
        let n = back.len();
        // Each goes on top: in reverse, they're back in their order.
        for d in back.into_iter().rev() {
            if !self.store_draft(d) {
                return;
            }
        }
        self.select_draft(Some(&id));
        self.toast(if n == 1 { "the draft is back".to_string() } else { format!("the {n} drafts are back") }, true);
    }

    /// Draft `id` left the list (sent, deleted): the prompt lets go of it
    /// if it was writing it, and the list closes when it was the last.
    fn forget(&mut self, id: &str) {
        if self.editing.as_ref().is_some_and(|e| e.id == id) {
            self.editing = None;
            self.field = Field::default();
            self.images.clear();
            self.plan = false;
        }
        self.select_draft(None);
        if self.drafts.is_empty() {
            self.close_list();
        }
    }

    /// `o -d`: start in the drafts list.
    pub fn start_in_list(&mut self) {
        self.open_list();
    }

    fn ctrl_c(&mut self) -> Act {
        if let Some(text) = self.field.selected().map(String::from) {
            self.clip(text);
            return Act::None;
        }
        if self.field.text.is_empty() {
            if self.editing.is_some() {
                self.leave_draft();
                return Act::None;
            }
            return Act::Quit;
        }
        self.clear_box("cleared · ^z brings it back · ^c again quits");
        Act::None
    }

    fn clear_box(&mut self, msg: &str) {
        self.cleared = Some((std::mem::take(&mut self.field), std::mem::take(&mut self.images)));
        self.toast(msg, true);
    }

    /// ^x: the selection onto the clipboard, and out of the text.
    fn cut(&mut self) {
        let Some(text) = self.field.selected().map(String::from) else { return };
        self.clip(text);
        self.field.delete_selection();
    }

    /// ^z: what was cleared or sent, back (and what's there now kept for
    /// another ^z).
    fn unclear(&mut self) {
        let Some(c) = self.cleared.as_mut() else { return };
        std::mem::swap(&mut self.field, &mut c.0);
        std::mem::swap(&mut self.images, &mut c.1);
        self.field.end();
        self.toast("brought it back", true);
    }

    /// ⌥c: `text` alone onto the clipboard, its `[Image #N]` tags and
    /// extra spaces and blank lines out (field::plain).
    fn copy_plain(&mut self, text: &str) {
        let plain = field::plain(text);
        if !plain.is_empty() {
            self.clip(plain);
        } else if field::image_tags(text).is_empty() {
            self.toast("nothing to copy", false);
        } else {
            self.toast("nothing to copy but images", false);
        }
    }

    /// `text` onto the clipboard (pbcopy).
    fn clip(&mut self, text: String) {
        let n = text.chars().count();
        if !self.live {
            self.would_copy = Some(text);
            return;
        }
        use std::io::Write;
        use std::process::{Command, Stdio};
        let ok = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .and_then(|mut c| {
                c.stdin.take().map(|mut i| i.write_all(text.as_bytes())).transpose()?;
                c.wait()
            })
            .is_ok_and(|s| s.success());
        if ok {
            self.toast(format!("copied {n} char{}", if n == 1 { "" } else { "s" }), true);
        } else {
            self.toast("couldn't copy (pbcopy)", false);
        }
    }

    fn attach(&mut self, path: PathBuf) {
        self.images.push(path);
        let tag = format!("[Image #{}]", self.images.len());
        self.field.insert_word(&tag);
    }

    /// ^v: the clipboard's image, as an `[Image #N]` tag.
    fn paste_image(&mut self) {
        match field::clipboard_image() {
            Some(p) => self.attach(p),
            None => self.toast("no image on the clipboard", false),
        }
    }

    /// Bracketed paste: the text, whole. Image files dropped in become tags,
    /// and an empty paste (⌘V with only an image on the clipboard) takes the
    /// clipboard's image.
    fn paste(&mut self, s: &str) {
        let s = s.replace("\r\n", "\n").replace('\r', "\n").replace('\t', "    ");
        if s.trim().is_empty() {
            match field::clipboard_image() {
                Some(p) => self.attach(p),
                None => self.field.insert(&s),
            }
            return;
        }
        match field::image_paths(&s) {
            Some(files) => files.into_iter().for_each(|f| self.attach(f)),
            None => self.field.insert(&s),
        }
    }

    // ---- mouse -------------------------------------------------------------

    /// A mouse event, its row counted from the prompt's first line (main.rs).
    fn mouse(&mut self, m: MouseEvent) {
        // The drafts list is the keys'.
        if self.list.is_some() {
            return;
        }
        // The lines as they are now: keys since the last frame moved them.
        self.layout(self.lay.width, self.lay.screen_h);
        let t = self.lay.text;
        let on_prompt = m.row < self.lay.height;
        match m.kind {
            MouseEventKind::ScrollUp if on_prompt => self.scroll = self.scroll.saturating_sub(3),
            MouseEventKind::ScrollDown if on_prompt => {
                let max = self.rows.len().saturating_sub(t.height as usize);
                self.scroll = (self.scroll + 3).min(max);
            }
            // (The pictures over a draft's text take no presses.)
            MouseEventKind::Down(MouseButton::Left) if on_prompt && m.row >= t.y => {
                let shift = m.modifiers.contains(KeyModifiers::SHIFT);
                self.press_text(m.column, m.row, shift);
            }
            MouseEventKind::Drag(MouseButton::Left) if self.press.is_some() => self.drag_text(m.column, m.row),
            MouseEventKind::Up(_) => self.press = None,
            _ => {}
        }
    }

    /// The place in the text under cell (x, y); above or below the text,
    /// the row past its edge when `drag` (so the text scrolls along).
    fn pos_at(&mut self, x: u16, y: u16, drag: bool) -> usize {
        let t = self.lay.text;
        let max = self.rows.len().saturating_sub(t.height as usize);
        let row = if y < t.y {
            if drag {
                self.scroll = self.scroll.saturating_sub(1);
            }
            self.scroll
        } else if y >= t.bottom() {
            if drag {
                self.scroll = (self.scroll + 1).min(max);
            }
            self.scroll + t.height as usize - 1
        } else {
            self.scroll + (y - t.y) as usize
        };
        let row = row.min(self.rows.len().saturating_sub(1));
        self.field.pos_at(&self.rows, row, x.saturating_sub(t.x) as usize)
    }

    /// How many presses in a row this one makes, on the same cell.
    fn count_press(&mut self, x: u16, y: u16) -> u8 {
        let n = match self.last_press {
            Some((at, px, py, n)) if at.elapsed() < MULTI_CLICK && (px, py) == (x, y) => n % 3 + 1,
            _ => 1,
        };
        self.last_press = Some((Instant::now(), x, y, n));
        n
    }

    fn span(&self, at: usize, n: u8) -> Range<usize> {
        match n {
            1 => at..at,
            2 => self.field.word_at(at),
            _ => self.field.line_at(at),
        }
    }

    /// A press on the prompt, as in a text area: the cursor there, a second
    /// on the cell its word, a third its line. With shift, the selection
    /// runs there from the cursor.
    fn press_text(&mut self, x: u16, y: u16, shift: bool) {
        let n = self.count_press(x, y);
        let at = self.pos_at(x, y, false);
        if shift && n == 1 {
            let from = self.field.anchor.unwrap_or(self.field.cur);
            self.field.select_from(from, at);
            self.press = Some((from..from, 1));
            return;
        }
        let span = self.span(at, n);
        self.field.select(span.clone());
        self.press = Some((span, n));
    }

    /// Dragging: the selection from the press to here, by its steps (words
    /// after a double-click), back from its end when it's above the press.
    fn drag_text(&mut self, x: u16, y: u16) {
        let Some((press, n)) = self.press.clone() else { return };
        let at = self.pos_at(x, y, true);
        let span = self.span(at, n);
        if at < press.start {
            self.field.select_from(press.end, span.start);
        } else {
            self.field.select_from(press.start, span.end.max(press.end));
        }
    }
}

// ---- the history file ----------------------------------------------------------

/// $XDG_STATE_HOME/o/history.jsonl (else ~/.local/state/o): one sent prompt
/// a line, `{"text": …, "images": […]}`, the newest last.
fn history_file() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME").filter(|s| !s.is_empty()).map(PathBuf::from);
    base.unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/state")).join("o/history.jsonl")
}

fn load_history() -> Vec<(String, Vec<PathBuf>)> {
    let Ok(s) = std::fs::read_to_string(history_file()) else { return Vec::new() };
    let mut all: Vec<(String, Vec<PathBuf>)> = s
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter_map(|v| {
            let text = v["text"].as_str()?.to_string();
            let images = v["images"].as_array().map(|a| a.iter().filter_map(|p| p.as_str().map(PathBuf::from)).collect()).unwrap_or_default();
            Some((text, images))
        })
        .collect();
    // Twice as long as it keeps: written again with the newest only.
    if all.len() > 2 * HISTORY {
        all.drain(..all.len() - HISTORY);
        let body: String = all.iter().map(|(t, i)| format!("{}\n", serde_json::json!({ "text": t, "images": i }))).collect();
        let _ = std::fs::write(history_file(), body);
    }
    all
}

fn append_history(text: &str, images: &[PathBuf]) {
    use std::io::Write;
    let path = history_file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let line = format!("{}\n", serde_json::json!({ "text": text, "images": images }));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rex_theme::{one_dark, Rgb};

    fn app(text: &str) -> App {
        let opts = Opts { cwd: "/tmp".into(), text: text.into(), label: String::new(), agents: crate::config::defaults(), start: 0, profiles: Vec::new(), profile: 0, notice: None, max_width: 0 };
        let mut a = App::new(Palette::new(&one_dark(Rgb(0x28, 0x2c, 0x34))), opts);
        a.live = false;
        a
    }

    fn press(a: &mut App, code: KeyCode, mods: KeyModifiers) -> bool {
        matches!(a.handle(Event::Key(KeyEvent::new(code, mods))), Act::Quit)
    }

    #[test]
    fn enter_sends_and_empties_the_box() {
        let mut a = app("fix the header");
        a.plan = true;
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(a.would_send.as_deref(), Some("/plan fix the header"));
        assert_eq!(a.field.text, "");
        assert_eq!(a.sent.len(), 1);
        // Once it's started, it's printed above the prompt, once.
        assert!(a.tick());
        assert_eq!(a.take_done(), [0]);
        assert!(a.take_done().is_empty());
        // ^z brings it back, to send again.
        press(&mut a, KeyCode::Char('z'), KeyModifiers::CONTROL);
        assert_eq!(a.field.text, "fix the header");
    }

    #[test]
    fn selecting_a_sent_session_focuses_without_resending() {
        let mut a = app("first");
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        a.tick();
        type_in(&mut a, "second");
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        a.tick();
        press(&mut a, KeyCode::Up, KeyModifiers::NONE);
        assert_eq!(a.sent_at, Some(1));
        press(&mut a, KeyCode::Up, KeyModifiers::NONE);
        a.layout(80, 24);
        assert_eq!(a.sent_at, Some(0));
        assert_eq!(a.cursor_cell(), None);
        let rendered = crate::ui::draw(&a);
        assert!(crate::term::plain(&rendered, 0).contains("first"));
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(a.sent.len(), 2);
        assert_eq!(a.toast.as_ref().unwrap().0, "focused tab snapshot");
        press(&mut a, KeyCode::Down, KeyModifiers::NONE);
        press(&mut a, KeyCode::Down, KeyModifiers::NONE);
        assert_eq!(a.sent_at, None);
        assert!(a.field.text.is_empty());
        press(&mut a, KeyCode::Up, KeyModifiers::NONE);
        assert!(!press(&mut a, KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(a.sent_at, None);
    }

    #[test]
    fn pending_sessions_focus_once_started_and_failed_ones_cannot() {
        let mut a = app("first");
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        press(&mut a, KeyCode::Up, KeyModifiers::NONE);
        // ⏎ before its tab exists: kept, and done the moment it does.
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        assert!(a.toast.as_ref().unwrap().0.contains("as soon as it opens"));
        a.tick();
        assert_eq!(a.toast.as_ref().unwrap().0, "focused tab snapshot");
        assert_eq!(a.focus_next, None);
        a.sent[0].outcome = Some(("failed".into(), false, None));
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        assert!(a.toast.as_ref().unwrap().0.contains("no agent"));
        type_in(&mut a, "new prompt");
        assert_eq!(a.sent_at, None);
        assert_eq!(a.field.text, "new prompt");
        assert_eq!(a.sent.len(), 1);
    }

    #[test]
    fn up_and_down_go_through_what_was_sent() {
        let mut a = app("first");
        a.layout(60, 30);
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        for c in "second\nline".chars() {
            if c == '\n' {
                press(&mut a, KeyCode::Enter, KeyModifiers::SHIFT);
            } else {
                press(&mut a, KeyCode::Char(c), KeyModifiers::NONE);
            }
        }
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        for c in "draft".chars() {
            press(&mut a, KeyCode::Char(c), KeyModifiers::NONE);
        }
        press(&mut a, KeyCode::Up, KeyModifiers::NONE);
        assert_eq!(a.field.text, "second\nline");
        // On its last row: ↑ goes up a row first, then further back.
        press(&mut a, KeyCode::Up, KeyModifiers::NONE);
        assert_eq!((a.field.text.as_str(), a.field.cur), ("second\nline", 4));
        press(&mut a, KeyCode::Up, KeyModifiers::NONE);
        assert_eq!(a.field.text, "first");
        // Nothing older: to the start.
        press(&mut a, KeyCode::Up, KeyModifiers::NONE);
        assert_eq!((a.field.text.as_str(), a.field.cur), ("first", 0));
        press(&mut a, KeyCode::Down, KeyModifiers::NONE);
        assert_eq!(a.field.text, "second\nline");
        press(&mut a, KeyCode::Down, KeyModifiers::NONE);
        press(&mut a, KeyCode::Down, KeyModifiers::NONE);
        assert_eq!(a.field.text, "draft");
    }

    fn type_in(a: &mut App, text: &str) {
        for c in text.chars() {
            press(a, KeyCode::Char(c), KeyModifiers::NONE);
        }
    }

    #[test]
    fn ctrl_s_keeps_a_draft_and_ctrl_g_goes_through_them() {
        let mut a = app("fix the header");
        press(&mut a, KeyCode::Char('s'), KeyModifiers::CONTROL);
        assert_eq!(a.drafts.len(), 1);
        // Saved as it's written from then on.
        type_in(&mut a, " now");
        a.sync_draft();
        assert_eq!(a.drafts[0].text, "fix the header now");
        // Esc leaves it for later: the prompt empties, the draft stays.
        assert!(!press(&mut a, KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!((a.field.text.as_str(), a.editing.is_none(), a.drafts.len()), ("", true, 1));
        // A second one, then through them: the newest is on top.
        type_in(&mut a, "second");
        press(&mut a, KeyCode::Char('s'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Esc, KeyModifiers::NONE);
        type_in(&mut a, "being written");
        press(&mut a, KeyCode::Char('g'), KeyModifiers::CONTROL);
        assert_eq!(a.list, Some(0));
        a.layout(60, 30);
        assert_eq!((a.view.shown, a.view.preview, a.cursor_cell()), (2, 1, None));
        press(&mut a, KeyCode::Char('j'), KeyModifiers::NONE);
        press(&mut a, KeyCode::Char('e'), KeyModifiers::NONE);
        assert_eq!((a.field.text.as_str(), a.list), ("fix the header now", None));
        // Esc out of it goes back to the list, on it; esc again to the
        // prompt as it was.
        type_in(&mut a, "!");
        press(&mut a, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!((a.list, a.drafts[1].text.as_str()), (Some(1), "fix the header now!"));
        press(&mut a, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!((a.field.text.as_str(), a.list), ("being written", None));
    }

    #[test]
    fn a_draft_is_sent_deleted_and_brought_back() {
        let mut a = app("one");
        press(&mut a, KeyCode::Char('p'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Char('s'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Esc, KeyModifiers::NONE);
        type_in(&mut a, "two");
        press(&mut a, KeyCode::Char('s'), KeyModifiers::CONTROL);
        // ⏎ in a draft sends it, and it goes.
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!((a.would_send.as_deref(), a.drafts.len(), a.field.text.as_str()), (Some("two"), 1, ""));
        // x deletes, u brings it back, ⏎ on it sends it as it was kept.
        press(&mut a, KeyCode::Char('g'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Char('x'), KeyModifiers::NONE);
        assert_eq!((a.drafts.len(), a.list), (0, None));
        // Nothing to go through: ^g stays on the prompt.
        press(&mut a, KeyCode::Char('g'), KeyModifiers::CONTROL);
        assert_eq!(a.list, None);
        a.drafts.push(a.undo[0].clone());
        press(&mut a, KeyCode::Char('g'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!((a.would_send.as_deref(), a.drafts.len(), a.list), (Some("/plan one"), 0, None));
    }

    #[test]
    fn an_emptied_draft_goes_and_history_stays_out_of_one() {
        let mut a = app("sent before");
        a.layout(60, 30);
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        type_in(&mut a, "x");
        press(&mut a, KeyCode::Char('s'), KeyModifiers::CONTROL);
        // ↑ doesn't recall over a draft.
        press(&mut a, KeyCode::Up, KeyModifiers::NONE);
        assert_eq!(a.field.text, "x");
        press(&mut a, KeyCode::Char('k'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!((a.drafts.len(), a.editing.is_none()), (0, true));
    }

    #[test]
    fn ctrl_y_puts_back_what_was_deleted_and_ctrl_l_clears_the_screen() {
        let mut a = app("one two three");
        press(&mut a, KeyCode::Char('w'), KeyModifiers::CONTROL);
        assert_eq!(a.field.text, "one two ");
        press(&mut a, KeyCode::Char('a'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Char('y'), KeyModifiers::CONTROL);
        assert_eq!(a.field.text, "threeone two ");
        press(&mut a, KeyCode::Char('k'), KeyModifiers::CONTROL);
        assert_eq!(a.field.text, "three");
        press(&mut a, KeyCode::Char('y'), KeyModifiers::CONTROL);
        assert_eq!(a.field.text, "threeone two ");
        let cleared = matches!(a.handle(Event::Key(KeyEvent::new(KeyCode::Char('l'), KeyModifiers::CONTROL))), Act::ClearScreen);
        assert!(cleared);
        assert_eq!(a.field.text, "threeone two ");
    }

    #[test]
    fn option_c_copies_the_text_without_its_images() {
        let mut a = app("  look at [Image #1] .\n[Image #2]\n\n\nthen   fix it  ");
        press(&mut a, KeyCode::Char('c'), KeyModifiers::ALT);
        assert_eq!(a.would_copy.as_deref(), Some("  look at.\n\nthen fix it"));
        // Untouched, and not typed into.
        assert_eq!(a.field.text, "  look at [Image #1] .\n[Image #2]\n\n\nthen   fix it  ");
        // The selection's, when there's one.
        press(&mut a, KeyCode::Left, KeyModifiers::SHIFT.union(KeyModifiers::ALT));
        press(&mut a, KeyCode::Left, KeyModifiers::SHIFT.union(KeyModifiers::ALT));
        press(&mut a, KeyCode::Char('c'), KeyModifiers::ALT);
        assert_eq!(a.would_copy.as_deref(), Some("fix it"));
        // Images alone copy nothing.
        let mut a = app("[Image #1] [Image #2]");
        press(&mut a, KeyCode::Char('c'), KeyModifiers::ALT);
        assert_eq!(a.would_copy, None);
        // In the drafts list, the selected draft's.
        let mut a = app("a draft  [Image #1]");
        press(&mut a, KeyCode::Char('s'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Esc, KeyModifiers::NONE);
        press(&mut a, KeyCode::Char('g'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Char('c'), KeyModifiers::ALT);
        assert_eq!((a.would_copy.as_deref(), a.list), (Some("a draft"), Some(0)));
    }

    #[test]
    fn shift_enter_is_a_newline_and_esc_twice_clears() {
        let mut a = app("one");
        press(&mut a, KeyCode::Enter, KeyModifiers::SHIFT);
        press(&mut a, KeyCode::Char('t'), KeyModifiers::NONE);
        assert_eq!(a.field.text, "one\nt");
        assert!(!press(&mut a, KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(a.field.text, "one\nt");
        assert!(!press(&mut a, KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(a.field.text, "");
        // An empty box: esc quits.
        assert!(press(&mut a, KeyCode::Esc, KeyModifiers::NONE));
    }

    #[test]
    fn lays_out_the_text_and_its_cursor() {
        let mut a = app("");
        a.field = Field { text: "look at [Image #1] here\nand this".into(), ..Default::default() };
        a.layout(60, 30);
        // 60 wide: 43 columns of text, after `claude(opus) > `; nothing over
        // or under it.
        assert_eq!(a.prefix(), "claude(opus) >");
        assert_eq!((a.lay.text, a.lay.height), (Rect::new(15, 0, 43, 2), 2));
        assert_eq!(a.cursor_cell(), Some((15, 0)));
        a.field.end();
        a.layout(60, 30);
        assert_eq!(a.cursor_cell(), Some((23, 1)));
        // Too narrow for the name: `>` only, as before.
        a.layout(30, 30);
        assert_eq!((a.prefix().as_str(), a.lay.text), (">", Rect::new(2, 0, 26, 2)));
        // A toast takes a line under it.
        a.toast("hi", true);
        a.layout(60, 30);
        assert_eq!(a.lay.height, 3);
    }

    #[test]
    fn max_width_keeps_a_wide_pane_from_stretching_the_text() {
        let mut a = app(&"word ".repeat(60));
        a.max_width = 100;
        // 300 wide draws in 100: 83 columns of text after `claude(opus) > `,
        // and the frame is 99 (the last column left alone, as on any pane).
        a.layout(300, 30);
        assert_eq!((a.lay.width, a.lay.text.width), (100, 83));
        assert_eq!(crate::ui::draw(&a).area.width, 99);
        assert!(a.rows.iter().all(|r| a.field.text[r.clone()].trim_end().len() <= 83));
        // Narrower than the cap: the pane's width, as before.
        a.layout(60, 30);
        assert_eq!(a.lay.text.width, 43);
        // 0: no cap.
        a.max_width = 0;
        a.layout(300, 30);
        assert_eq!(a.lay.width, 300);
    }

    #[test]
    fn a_long_prompt_scrolls_to_keep_the_cursor_in_view() {
        let mut a = app(&"line\n".repeat(40));
        a.layout(60, 10);
        // 9 rows (one left for what was above); the cursor on the last.
        assert_eq!((a.lay.text.height, a.scroll), (9, 32));
        assert_eq!(a.cursor_cell(), Some((15, 8)));
    }

    #[test]
    fn shift_tab_and_ctrl_digits_pick_the_configuration() {
        let mut a = app("fix it");
        a.layout(80, 30);
        assert_eq!(a.prefix(), "claude(opus) >");
        press(&mut a, KeyCode::BackTab, KeyModifiers::SHIFT);
        a.layout(80, 30);
        assert_eq!((a.prefix().as_str(), a.lay.text.x), ("claude(fable) >", 16));
        press(&mut a, KeyCode::BackTab, KeyModifiers::SHIFT);
        a.layout(80, 30);
        assert_eq!((a.prefix().as_str(), a.lay.text.x), ("codex >", 8));
        // Round to the first.
        press(&mut a, KeyCode::BackTab, KeyModifiers::SHIFT);
        assert_eq!(a.agent().name, "claude(opus)");
        press(&mut a, KeyCode::Char('3'), KeyModifiers::CONTROL);
        assert_eq!(a.agent().name, "codex");
        press(&mut a, KeyCode::Char('2'), KeyModifiers::CONTROL);
        assert_eq!(a.agent().name, "claude(fable)");
        // Nothing typed, and no configuration 7: it stays.
        press(&mut a, KeyCode::Char('7'), KeyModifiers::CONTROL);
        assert_eq!((a.agent().name.as_str(), a.field.text.as_str()), ("claude(fable)", "fix it"));
        assert!(a.toast.as_ref().is_some_and(|t| !t.1));
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(a.sent[0].name, "claude(fable)");
    }

    #[test]
    fn ctrl_n_goes_through_the_claude_profiles() {
        let mut a = app("fix it");
        // The main profile alone: nothing to pick, and the prompt as before.
        press(&mut a, KeyCode::Char('n'), KeyModifiers::CONTROL);
        assert!(a.toast.as_ref().is_some_and(|t| !t.1));
        a.layout(80, 30);
        assert_eq!(a.prefix(), "claude(opus) >");
        a.profiles = vec![
            Profile { name: crate::config::MAIN.into(), dir: "/h/.claude".into() },
            Profile { name: "2".into(), dir: "/h/.claude-2".into() },
        ];
        press(&mut a, KeyCode::Char('n'), KeyModifiers::CONTROL);
        a.layout(80, 30);
        assert_eq!((a.prefix().as_str(), a.lay.text.x), ("claude(opus)·2 >", 17));
        assert!(a.toast.as_ref().is_some_and(|t| t.1 && t.0.starts_with("Claude profile 2 (/h/.claude-2)")));
        // Codex has none: shown as it is, and sent as it is.
        press(&mut a, KeyCode::Char('3'), KeyModifiers::CONTROL);
        a.layout(80, 30);
        assert_eq!(a.prefix(), "codex >");
        press(&mut a, KeyCode::Char('1'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(a.sent[0].name, "claude(opus)·2");
        // A draft keeps its configuration by its own name, not the profile's.
        type_in(&mut a, "later");
        press(&mut a, KeyCode::Char('s'), KeyModifiers::CONTROL);
        assert_eq!(a.drafts[0].config.as_deref(), Some("claude(opus)"));
        // Round to the main one.
        press(&mut a, KeyCode::Esc, KeyModifiers::NONE);
        press(&mut a, KeyCode::Char('n'), KeyModifiers::CONTROL);
        a.layout(80, 30);
        assert_eq!(a.prefix(), "claude(opus) >");
    }

    #[test]
    fn a_draft_keeps_its_configuration() {
        let mut a = app("on fable");
        press(&mut a, KeyCode::Char('2'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Char('s'), KeyModifiers::CONTROL);
        assert_eq!((a.drafts[0].kind.as_deref(), a.drafts[0].config.as_deref()), (Some("claude"), Some("claude(fable)")));
        a.layout(80, 30);
        assert_eq!(a.prefix(), "claude(fable) ◇");
        // Switched while it's written: saved with it.
        press(&mut a, KeyCode::Char('3'), KeyModifiers::CONTROL);
        a.sync_draft();
        assert_eq!(a.drafts[0].config.as_deref(), Some("codex"));
        press(&mut a, KeyCode::Char('2'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Esc, KeyModifiers::NONE);
        // Back on the first; opening the draft goes back to fable.
        press(&mut a, KeyCode::Char('1'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Char('g'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Char('e'), KeyModifiers::NONE);
        assert_eq!(a.agent().name, "claude(fable)");
        // One al saved (no config): the first of its kind.
        a.drafts[0].config = None;
        a.drafts[0].kind = Some("codex".into());
        assert_eq!(a.agent_of(&a.drafts[0].clone()), Some(2));
    }

    /// Drafts written in this order (so the list has them newest first).
    fn with_drafts(texts: &[&str]) -> App {
        let mut a = app("");
        for t in texts {
            type_in(&mut a, t);
            press(&mut a, KeyCode::Char('s'), KeyModifiers::CONTROL);
            press(&mut a, KeyCode::Esc, KeyModifiers::NONE);
        }
        a
    }

    #[test]
    fn shift_arrows_mark_and_enter_sends_the_marked_as_one_prompt() {
        let mut a = with_drafts(&["third", "second", "first"]);
        press(&mut a, KeyCode::Char('g'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Down, KeyModifiers::SHIFT);
        press(&mut a, KeyCode::Down, KeyModifiers::SHIFT);
        assert_eq!((a.list, a.marked.len()), (Some(2), 3));
        // Back over the run unmarks what it marked.
        press(&mut a, KeyCode::Up, KeyModifiers::SHIFT);
        assert_eq!((a.list, a.marked.len()), (Some(1), 2));
        a.layout(100, 30);
        let keys = crate::term::plain(&crate::ui::draw(&a), a.lay.text.bottom() - 1);
        assert!(keys.starts_with("  2 marked · "), "{keys}");
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        let sent = a.would_send.clone().unwrap();
        assert!(sent.starts_with("Here are 2 tasks"), "{sent}");
        assert!(sent.ends_with("## Task 1 of 2\n\nfirst\n\n## Task 2 of 2\n\nsecond"), "{sent}");
        assert_eq!(a.sent[0].text, "2 drafts as one prompt\n1. first\n2. second");
        // They went; the one left is still in the list, unmarked.
        assert_eq!((a.drafts.len(), a.drafts[0].text.as_str(), a.list, a.marked.len()), (1, "third", Some(0), 0));
    }

    #[test]
    fn space_marks_one_x_deletes_the_marked_and_u_brings_them_back() {
        let mut a = with_drafts(&["c", "b", "a"]);
        press(&mut a, KeyCode::Char('g'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Char(' '), KeyModifiers::NONE);
        press(&mut a, KeyCode::Char('j'), KeyModifiers::NONE);
        press(&mut a, KeyCode::Char('j'), KeyModifiers::NONE);
        press(&mut a, KeyCode::Char(' '), KeyModifiers::NONE);
        press(&mut a, KeyCode::Char('x'), KeyModifiers::NONE);
        assert_eq!(a.drafts.iter().map(|d| d.text.as_str()).collect::<Vec<_>>(), ["b"]);
        press(&mut a, KeyCode::Char('u'), KeyModifiers::NONE);
        assert_eq!(a.drafts.iter().map(|d| d.text.as_str()).collect::<Vec<_>>(), ["a", "c", "b"]);
        // a marks all, again none; esc unmarks before it leaves.
        press(&mut a, KeyCode::Char('a'), KeyModifiers::NONE);
        assert_eq!(a.marked.len(), 3);
        press(&mut a, KeyCode::Char('a'), KeyModifiers::NONE);
        assert!(a.marked.is_empty());
        press(&mut a, KeyCode::Char(' '), KeyModifiers::NONE);
        press(&mut a, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!((a.marked.len(), a.list.is_some()), (0, true));
        press(&mut a, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!(a.list, None);
    }

    #[test]
    fn one_marked_goes_as_itself_and_replies_dont_go_with_others() {
        let mut a = with_drafts(&["two", "one"]);
        press(&mut a, KeyCode::Char('g'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Char('j'), KeyModifiers::NONE);
        press(&mut a, KeyCode::Char(' '), KeyModifiers::NONE);
        press(&mut a, KeyCode::Char('k'), KeyModifiers::NONE);
        // The cursor's on "one", but ⏎ sends what's marked.
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!((a.would_send.as_deref(), a.drafts[0].text.as_str()), (Some("two"), "one"));
        let mut a = with_drafts(&["two", "one"]);
        a.drafts[0].reply = Some(crate::drafts::ReplyTo { pane: "block:1".into(), tab: String::new(), label: "auth".into(), session: None });
        press(&mut a, KeyCode::Char('g'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Char('a'), KeyModifiers::NONE);
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!((a.would_send, a.drafts.len()), (None, 2));
        assert!(a.toast.as_ref().unwrap().0.contains("its own agent"));
    }

    #[test]
    fn the_selected_drafts_images_go_over_the_list() {
        let mut a = with_drafts(&["no pictures"]);
        type_in(&mut a, "look ");
        a.attach("/wide.png".into());
        a.attach("/square.png".into());
        press(&mut a, KeyCode::Char('s'), KeyModifiers::CONTROL);
        press(&mut a, KeyCode::Esc, KeyModifiers::NONE);
        a.gfx = Some(Gfx { cell_w: 10, cell_h: 20 });
        let pic = |w, h| Some(Ok(Pic { w, h, b64: "AAAA".into() }));
        a.pics.insert("/wide.png".into(), pic(900, 450));
        a.pics.insert("/square.png".into(), pic(90, 90));
        press(&mut a, KeyCode::Char('g'), KeyModifiers::CONTROL);
        a.layout(100, 40);
        // 8 rows tall at most, its shape kept; the small one its own size.
        let v = a.view.clone();
        assert_eq!(v.strip, 9);
        assert_eq!(v.thumbs.iter().map(|t| (t.x, t.cols, t.rows, t.n)).collect::<Vec<_>>(), [(0, 32, 8, 1), (34, 9, 5, 2)]);
        let b = crate::ui::draw(&a);
        let row = |y| crate::term::plain(&b, y);
        assert!(row(0).starts_with(&format!("  {}  {}", "▒".repeat(32), "▒".repeat(9))), "{}", row(0));
        assert!(row(5).contains("[Image #2]") && row(8).starts_with("  [Image #1]"));
        assert!(row(9).starts_with("▸ ◇ look [Image #1] [Image #2]"));
        // Sent to the terminal once, then drawn from what it has.
        assert_eq!(a.take_gfx().windows(4).filter(|w| w == b"\x1b_Ga").count(), 2);
        a.layout(100, 40);
        assert!(a.take_gfx().is_empty());
        // A draft without any keeps the room, so the list stays put.
        press(&mut a, KeyCode::Char('j'), KeyModifiers::NONE);
        a.layout(100, 40);
        assert_eq!((a.view.strip, a.view.thumbs.len(), a.view.note.as_deref()), (9, 0, Some("no images")));
        // A short screen shrinks it, then has no room for it.
        a.layout(100, 12);
        assert_eq!(a.view.strip, 7);
        a.layout(100, 8);
        assert_eq!(a.view.strip, 0);
        // Images not drawn: none of it.
        a.gfx = None;
        a.layout(100, 40);
        assert_eq!(a.view.strip, 0);
        assert!(a.clear_images().windows(5).any(|w| w == b"a=d,d"));
    }

    #[test]
    fn a_drafts_images_go_over_its_text_in_one_row() {
        let mut a = app("");
        a.gfx = Some(Gfx { cell_w: 10, cell_h: 20 });
        let pic = |w, h| Some(Ok(Pic { w, h, b64: "AAAA".into() }));
        for p in ["/wide.png", "/w2.png", "/w3.png"] {
            a.pics.insert(p.into(), pic(900, 450));
        }
        a.pics.insert("/square.png".into(), pic(90, 90));
        type_in(&mut a, "look ");
        a.attach("/wide.png".into());
        a.attach("/square.png".into());
        // Not a draft: no pictures.
        a.layout(100, 40);
        assert_eq!((a.pictures.height, a.lay.text.y), (0, 0));
        press(&mut a, KeyCode::Char('s'), KeyModifiers::CONTROL);
        a.toast = None;
        a.layout(100, 40);
        // All 8 rows tall (the small one too), each its shape, labels under
        // them; the text under that, lined up with them.
        let row_of = |a: &App| a.pictures.thumbs.iter().map(|t| (t.x, t.cols, t.rows, t.n)).collect::<Vec<_>>();
        assert_eq!(a.pictures.height, 9);
        assert_eq!(row_of(&a), [(0, 32, 8, 1), (34, 16, 8, 2)]);
        assert_eq!((a.lay.text, a.lay.height), (Rect::new(15, 9, 83, 1), 10));
        let b = crate::ui::draw(&a);
        let row = |y| crate::term::plain(&b, y);
        let pad = " ".repeat(15);
        assert_eq!(row(0), format!("{pad}{}  {}", "▒".repeat(32), "▒".repeat(16)));
        assert_eq!(row(8), format!("{pad}[Image #1]{}[Image #2]", " ".repeat(24)));
        assert!(row(9).starts_with("claude(opus) ◇ look [Image #1] [Image #2]"), "{}", row(9));
        assert_eq!(a.cursor_cell().map(|c| c.1), Some(9));
        // A press on them leaves the cursor be.
        let cur = a.field.cur;
        a.handle(Event::Mouse(MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: 20, row: 3, modifiers: KeyModifiers::NONE }));
        assert_eq!(a.field.cur, cur);
        // More than fit at 8 rows: all of them, shorter.
        a.field.end();
        a.attach("/w2.png".into());
        a.attach("/w3.png".into());
        a.layout(100, 40);
        assert_eq!(row_of(&a), [(0, 20, 5, 1), (22, 10, 5, 2), (34, 20, 5, 3), (56, 20, 5, 4)]);
        assert_eq!((a.pictures.height, a.pictures.note.as_deref(), a.lay.text.y), (6, None, 6));
        // Copied beside the draft: drawn from what the terminal has.
        a.take_gfx();
        let kept: Vec<PathBuf> = a.images.iter().map(|p| PathBuf::from("/kept").join(p.file_name().unwrap())).collect();
        let before = std::mem::replace(&mut a.images, kept.clone());
        a.images_moved(&before, &kept);
        a.layout(100, 40);
        assert_eq!(a.pictures.thumbs.len(), 4);
        assert!(a.take_gfx().is_empty());
        // Too narrow for them all even small: as many as fit, then a count.
        a.layout(40, 40);
        assert_eq!(row_of(&a), [(0, 8, 2, 1), (12, 4, 2, 2)]);
        assert_eq!(a.pictures.note.as_deref(), Some("+2 more"));
        // A short screen shrinks them, then has no room for them.
        a.layout(100, 5);
        assert_eq!((a.pictures.height, a.pictures.thumbs[0].rows), (3, 2));
        a.layout(100, 4);
        assert_eq!((a.pictures.height, a.lay.text.y), (0, 0));
        // Images not drawn: none of it.
        a.gfx = None;
        a.layout(100, 40);
        assert_eq!(a.pictures.height, 0);
        // Out of the draft: gone.
        a.gfx = Some(Gfx { cell_w: 10, cell_h: 20 });
        press(&mut a, KeyCode::Esc, KeyModifiers::NONE);
        a.layout(100, 40);
        assert_eq!(a.pictures.height, 0);
    }

    #[test]
    fn option_cmd_n_shows_the_prompts_images_and_a_send_keeps_them() {
        let mut a = app("");
        type_in(&mut a, "see ");
        a.attach("/one.png".into());
        a.attach("/two.png".into());
        assert_eq!(a.showing(), [(1, PathBuf::from("/one.png")), (2, PathBuf::from("/two.png"))]);
        // A tag deleted: its image isn't shown.
        a.field.text = "see [Image #2]".into();
        a.field.end();
        assert_eq!(a.showing(), [(2, PathBuf::from("/two.png"))]);
        // Sent: the agent's pane gets them; the prompt has none left.
        press(&mut a, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(a.sent[0].images, [(2, PathBuf::from("/two.png"))]);
        assert!(a.showing().is_empty());
    }

    #[test]
    fn a_click_puts_the_cursor_there() {
        let mut a = app("see this\nnext");
        a.layout(60, 30);
        let t = a.lay.text;
        a.handle(Event::Mouse(MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: t.x + 3, row: t.y, modifiers: KeyModifiers::NONE }));
        assert_eq!(a.field.cur, 3);
        a.last_press = None;
        a.handle(Event::Mouse(MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: t.x + 2, row: t.y + 1, modifiers: KeyModifiers::NONE }));
        assert_eq!(a.field.cur, 11);
    }
}
