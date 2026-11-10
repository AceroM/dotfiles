//! State, keys and the mouse. One prompt, as `claude >` and `codex ›` have:
//! write it (as many lines as it takes, images pasted in), ⏎ starts the
//! agent with it in a new Herdr tab, and the prompt empties for the next one.
//! A pasted image is an `[Image #N]` tag in the text, its file listed at the
//! end of what's sent; it isn't drawn.
//!
//! Drafts are al's (drafts.rs): ^s keeps the prompt as one, saved as it's
//! written from then on (esc leaves it for later, ⏎ sends it and it goes);
//! ^g goes through this space's drafts, a list in the prompt's place with
//! al's keys: j k, ⏎ sends, e edits, x deletes, u brings it back, d a new one.

use std::ops::Range;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant, SystemTime};

use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;
use unicode_width::UnicodeWidthStr;

use crate::drafts::{self, Draft};
use crate::field::{self, Field};
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

pub enum Act {
    None,
    Quit,
    /// ^l: clear the screen, the prompt at its top (main.rs).
    ClearScreen,
}

/// Prompts kept for ↑, the newest last.
const HISTORY: usize = 500;

/// A prompt sent: its agent, its text, and how the start went (None while
/// it's starting).
pub struct Sent {
    pub kind: String,
    pub text: String,
    pub plan: bool,
    pub outcome: Option<Outcome>,
}

/// Where things are, in lines from the prompt's first.
#[derive(Clone, Copy, Default)]
pub struct Lay {
    /// The terminal's size.
    pub width: u16,
    pub screen_h: u16,
    /// Where the text's rows go (the prompt glyph is left of them).
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
}

pub struct Opts {
    /// Where the agents start.
    pub cwd: PathBuf,
    /// What the prompt starts with.
    pub text: String,
    /// The first tab's label (a note's name); empty leaves it to Herdr.
    pub label: String,
}

pub struct App {
    pub pal: Palette,
    pub field: Field,
    /// The file behind each tag: `[Image #N]` is `images[N - 1]`.
    pub images: Vec<PathBuf>,
    pub cwd: PathBuf,
    pub label: String,
    pub agents: Vec<(String, Vec<String>)>,
    /// Which of `agents` ⏎ starts (shift+tab).
    pub kind: usize,
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
    /// This space's drafts, newest first (al's file: drafts.rs).
    pub drafts: Vec<Draft>,
    /// The drafts file's time when last read.
    drafts_seen: Option<SystemTime>,
    /// This Herdr space's id and name, asked for at the first draft.
    scope: Option<(String, String)>,
    /// The draft the prompt is writing, as last saved.
    pub editing: Option<Draft>,
    /// Going through the drafts (^g): the one selected.
    pub list: Option<usize>,
    pub view: ListView,
    /// The draft being written was opened from the list: esc goes back there.
    from_list: bool,
    /// The prompt that was being written when a draft took its place: its
    /// text, images, agent and plan mode. Back when the draft is left.
    aside: Option<(Field, Vec<PathBuf>, usize, bool)>,
    /// The draft `x` deleted last: `u` brings it back.
    undo: Option<Draft>,
    last_key: Instant,
    pub toast: Option<(String, bool, Instant)>,
    pub sent: Vec<Sent>,
    /// Sends that finished, to print above the prompt.
    done: Vec<usize>,
    sent_tx: Sender<(usize, Outcome)>,
    sent_rx: Receiver<(usize, Outcome)>,
    pub lay: Lay,
    /// The text's rows, as `lay.text` wraps them.
    pub rows: Vec<Range<usize>>,
    /// The first of `lines` in view.
    pub scroll: usize,
    /// The cursor, text and width the view last followed: the wheel can
    /// leave the cursor out of view until it moves.
    followed: Option<(usize, usize, Option<usize>, u16, u16)>,
    /// A press in the text: the span it took, and how many presses in a row.
    press: Option<(Range<usize>, u8)>,
    last_press: Option<(Instant, u16, u16, u8)>,
    /// False for --snapshot: nothing is sent or copied, only noted.
    pub live: bool,
    pub would_send: Option<String>,
    pub would_copy: Option<String>,
}

impl App {
    pub fn new(pal: Palette, opts: Opts) -> App {
        let (sent_tx, sent_rx) = mpsc::channel();
        let mut field = Field { text: opts.text, ..Default::default() };
        field.end();
        App {
            pal,
            field,
            images: Vec::new(),
            cwd: opts.cwd,
            label: opts.label,
            agents: spawn::agents(),
            kind: 0,
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
            from_list: false,
            aside: None,
            undo: None,
            last_key: Instant::now(),
            toast: None,
            sent: Vec::new(),
            done: Vec::new(),
            sent_tx,
            sent_rx,
            lay: Lay::default(),
            rows: Vec::new(),
            scroll: 0,
            followed: None,
            press: None,
            last_press: None,
            live: true,
            would_send: None,
            would_copy: None,
        }
    }

    pub fn kind(&self) -> &str {
        &self.agents[self.kind].0
    }

    pub fn toast(&mut self, m: impl Into<String>, ok: bool) {
        self.toast = Some((m.into(), ok, Instant::now()));
    }

    // ---- layout ------------------------------------------------------------

    /// The columns the text wraps to on a terminal `w` wide: less the `> `
    /// gutter, a column for the cursor past a full row, and the last column,
    /// left alone (writing there leaves the terminal waiting to wrap).
    fn text_width(w: u16) -> usize {
        (w as usize).saturating_sub(4).max(4)
    }

    /// Lay the prompt out for a `width`×`screen_h` terminal: its text's rows,
    /// as many as there are up to the screen, scrolled to keep the cursor in
    /// view; under them a toast and what's starting, when there are.
    pub fn layout(&mut self, width: u16, screen_h: u16) {
        let tw = Self::text_width(width);
        let starting = self.sent.iter().filter(|s| s.outcome.is_none()).count();
        let extra = usize::from(self.toast.is_some()) + starting;
        // A line of what was there before stays in view.
        let room = (screen_h as usize).saturating_sub(extra + 1).max(1);
        if self.drafts.is_empty() {
            self.list = None;
        }
        if let Some(sel) = self.list {
            let sel = sel.min(self.drafts.len() - 1);
            self.list = Some(sel);
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
            let body = shown + preview + usize::from(more > 0 && fits > 0) + 1;
            self.view = ListView { top, shown, rows, preview, more };
            self.rows.clear();
            self.lay = Lay { width, screen_h, text: Rect::new(2, 0, tw as u16, body as u16), height: (body + extra) as u16 };
            return;
        }
        self.rows = field::word_rows(&self.field.text, tw);
        let view = self.rows.len().clamp(1, room);
        let text = Rect::new(2, 0, tw as u16, view as u16);
        self.lay = Lay { width, screen_h, text, height: (view + extra) as u16 };
        self.follow(view);
    }

    /// Something will change without a key: a send starting, a toast to
    /// take down. The loop wakes more often then.
    pub fn busy(&self) -> bool {
        self.toast.is_some() || self.sent.iter().any(|s| s.outcome.is_none())
    }

    /// The row the cursor is on.
    pub fn cursor_row(&self) -> usize {
        self.rows.iter().rposition(|r| r.start <= self.field.cur).unwrap_or(0)
    }

    /// Where the terminal's cursor goes, from the prompt's first line: on
    /// the cursor's cell, when its row is in view.
    pub fn cursor_cell(&self) -> Option<(u16, u16)> {
        if self.list.is_some() {
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
    fn follow(&mut self, view: usize) {
        let now = (self.field.cur, self.field.text.len(), self.field.anchor, self.lay.width, view as u16);
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

    // ---- the loop's hooks --------------------------------------------------

    /// Sends finished, a toast gone: true when the screen changed.
    pub fn tick(&mut self) -> bool {
        let mut changed = false;
        while let Ok((n, out)) = self.sent_rx.try_recv() {
            if let Some(s) = self.sent.get_mut(n) {
                s.outcome = Some(out);
                self.done.push(n);
            }
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

    /// Leaving oc: the draft being written saved (an empty one dropped).
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
        match k.code {
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
            KeyCode::BackTab => self.cycle_kind(),
            KeyCode::Tab if shift => self.cycle_kind(),
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
                let rows = field::word_rows(&self.field.text, Self::text_width(self.lay.width));
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

    fn cycle_kind(&mut self) {
        self.kind = (self.kind + 1) % self.agents.len();
        let msg = format!("{} next", self.kind());
        self.toast(msg, true);
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
        let kind = self.kind().to_string();
        let n = self.sent.len();
        self.sent.push(Sent { kind: kind.clone(), text: text.clone(), plan: self.plan, outcome: None });
        if self.live {
            spawn::send(n, &kind, &prompt, &self.cwd, &self.label, focus, self.sent_tx.clone());
        } else {
            // --snapshot: as if it started.
            self.would_send = Some(prompt);
            let _ = self.sent_tx.send((n, (format!("→ tab {}", if focus { "snapshot (went there)" } else { "snapshot" }), true)));
        }
        // A note's name labels the tab it went to, not the ones after.
        self.label.clear();
        self.cleared = Some((std::mem::take(&mut self.field), std::mem::take(&mut self.images)));
        self.scroll = 0;
    }

    // ---- drafts ------------------------------------------------------------

    /// This Herdr space: its id and name, asked for once.
    fn scope(&mut self) -> (String, String) {
        let live = self.live;
        self.scope
            .get_or_insert_with(|| if live { spawn::space() } else { (std::env::var("HERDR_WORKSPACE_ID").unwrap_or_default(), String::new()) })
            .clone()
    }

    /// This space's drafts from the file, when it changed (al may have
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
        if self.live {
            if let Err(e) = drafts::remove(id) {
                self.toast(format!("couldn't delete the draft: {e}"), false);
                return false;
            }
        }
        self.drafts.retain(|d| d.id != id);
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
    /// agent and plan mode.
    fn current(&self) -> Option<Draft> {
        let d = self.editing.as_ref()?;
        // A reply has no agent of its own to start.
        let kind = if d.reply.is_some() { d.kind.clone() } else { Some(self.kind().to_string()) };
        Some(Draft { text: self.field.text.clone(), images: self.images.clone(), kind, plan: self.plan, ..d.clone() })
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
            self.images = d.images.clone();
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
        let (cwd, kind, plan) = (self.cwd.clone(), Some(self.kind().to_string()), self.plan);
        let d = Draft { id, workspace, space, cwd, text, images: images.clone(), created: drafts::now(), reply: None, kind, plan };
        if !self.store_draft(d.clone()) {
            return;
        }
        self.images = images;
        self.editing = Some(d);
        self.from_list = false;
        self.hist_at = None;
        self.draft = None;
        self.toast("saved as a draft · esc keeps it for later · ^g goes through them", true);
    }

    /// ^g: go through this space's drafts.
    fn open_list(&mut self) {
        self.sync_draft();
        self.drafts_seen = None;
        self.reload_drafts();
        if self.drafts.is_empty() {
            return self.toast("no drafts in this space yet · ^s keeps the prompt as one", false);
        }
        let at = self.editing.as_ref().and_then(|e| self.drafts.iter().position(|d| d.id == e.id));
        self.list = Some(at.unwrap_or(0));
        self.view = ListView::default();
        self.toast = None;
    }

    /// Out of the list, back to the prompt as it was.
    fn close_list(&mut self) {
        self.list = None;
        if self.editing.is_none() {
            self.restore_aside();
        }
    }

    /// The prompt set aside for a draft, back (when there's one).
    fn restore_aside(&mut self) {
        if let Some((f, images, kind, plan)) = self.aside.take() {
            (self.field, self.images, self.kind, self.plan) = (f, images, kind, plan);
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
            self.aside = Some((std::mem::take(&mut self.field), std::mem::take(&mut self.images), self.kind, self.plan));
        }
        self.show(d.text.clone(), d.images.clone());
        if let Some(i) = d.kind.as_ref().and_then(|k| self.agents.iter().position(|a| &a.0 == k)) {
            self.kind = i;
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
        let done = |m: &str| (format!("→ {m}"), true);
        match to {
            Some((pane, label)) => {
                self.sent.push(Sent { kind: format!("↳{label}"), text: text.to_string(), plan: d.plan, outcome: None });
                if self.live {
                    spawn::reply(n, &pane, &prompt, self.sent_tx.clone());
                } else {
                    self.would_send = Some(format!("[to {label} {pane}] {prompt}"));
                    let _ = self.sent_tx.send((n, done("pane snapshot")));
                }
            }
            None => {
                let kind = d.kind.clone().filter(|k| self.agents.iter().any(|a| &a.0 == k)).unwrap_or_else(|| self.agents[0].0.clone());
                self.sent.push(Sent { kind: kind.clone(), text: text.to_string(), plan: d.plan, outcome: None });
                if self.live {
                    spawn::send(n, &kind, &prompt, &d.cwd, "", focus, self.sent_tx.clone());
                } else {
                    self.would_send = Some(prompt);
                    let _ = self.sent_tx.send((n, done(if focus { "tab snapshot (went there)" } else { "tab snapshot" })));
                }
            }
        }
        true
    }

    /// A key in the drafts list: al's.
    fn list_key(&mut self, k: KeyEvent) -> Act {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let Some(sel) = self.list else { return Act::None };
        let last = self.drafts.len().saturating_sub(1);
        let Some(d) = self.drafts.get(sel.min(last)).cloned() else {
            self.close_list();
            return Act::None;
        };
        // The one being written is as the prompt has it, saved or not yet.
        let d = self.current().filter(|c| c.id == d.id).unwrap_or(d);
        match k.code {
            KeyCode::Esc | KeyCode::Char('q') => self.close_list(),
            KeyCode::Char('c' | 'g' | 'd') if ctrl => self.close_list(),
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
                    self.undo = Some(d);
                    self.toast("deleted the draft · u brings it back", true);
                }
            }
            KeyCode::Char('u') => match self.undo.take() {
                Some(d) => {
                    let id = d.id.clone();
                    if self.store_draft(d) {
                        self.select_draft(Some(&id));
                        self.toast("the draft is back", true);
                    }
                }
                None => self.toast("no deleted draft to bring back", false),
            },
            // A new one, empty, to write.
            KeyCode::Char('d') => {
                let (workspace, space) = self.scope();
                let (cwd, kind) = (self.cwd.clone(), Some(self.agents[0].0.clone()));
                let d = Draft { id: drafts::new_id(), workspace, space, cwd, text: String::new(), images: Vec::new(), created: drafts::now(), reply: None, kind, plan: false };
                if self.store_draft(d.clone()) {
                    self.edit_draft(d, true);
                }
            }
            _ => {}
        }
        Act::None
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

    /// `oc -d`: start in the drafts list.
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
            MouseEventKind::Down(MouseButton::Left) if on_prompt => {
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

/// $XDG_STATE_HOME/oc/history.jsonl (else ~/.local/state/oc): one sent prompt
/// a line, `{"text": …, "images": […]}`, the newest last.
fn history_file() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME").filter(|s| !s.is_empty()).map(PathBuf::from);
    base.unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/state")).join("oc/history.jsonl")
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
    use crate::theme::Rgb;

    fn app(text: &str) -> App {
        let mut a = App::new(Palette::new(Rgb(0x28, 0x2c, 0x34)), Opts { cwd: "/tmp".into(), text: text.into(), label: String::new() });
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
        a.drafts.push(a.undo.clone().unwrap());
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
        // 60 wide: 56 columns of text, after `> `; nothing over or under it.
        assert_eq!((a.lay.text, a.lay.height), (Rect::new(2, 0, 56, 2), 2));
        assert_eq!(a.cursor_cell(), Some((2, 0)));
        a.field.end();
        a.layout(60, 30);
        assert_eq!(a.cursor_cell(), Some((10, 1)));
        // A toast takes a line under it.
        a.toast("hi", true);
        a.layout(60, 30);
        assert_eq!(a.lay.height, 3);
    }

    #[test]
    fn a_long_prompt_scrolls_to_keep_the_cursor_in_view() {
        let mut a = app(&"line\n".repeat(40));
        a.layout(60, 10);
        // 9 rows (one left for what was above); the cursor on the last.
        assert_eq!((a.lay.text.height, a.scroll), (9, 32));
        assert_eq!(a.cursor_cell(), Some((2, 8)));
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
