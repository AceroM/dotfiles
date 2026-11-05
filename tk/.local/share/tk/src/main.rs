//! tk — tab kill. Every browser tab in one list in the middle of the screen:
//! j/k to move, `;` to close, q to quit. No preview and no switching (ctab does
//! those); it is for clearing out tabs you don't need.

mod bridge;

use std::collections::HashSet;
use std::io;
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
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use bridge::{Host, Snap};

const HELP: &str = "\
tk — tab kill: every browser tab in a list; j/k to move, ; to close

usage:
  tk                   open the list

keys:
  j k  ↓ ↑             next / previous tab (5j, 3k: counts, by the relative numbers)
  ^d ^u                half a list down / up
  g G  12G             first / last / tab 12
  ; x                  close the tab (;;; closes a run)
  q esc                quit

options:
  --browser NAME       pick a connected browser when several are (also $BROWSER_USE_BROWSER)
  -h, --help

Talks to the browser-use extension (`browser-use status`), like ctab.
";

/// The list is re-read this often, so tabs opened or closed in Chrome show up.
const REFRESH: Duration = Duration::from_millis(1000);
const FLASH: Duration = Duration::from_secs(3);
/// The box is at most this wide.
const MAX_W: u16 = 100;

fn main() -> ExitCode {
    let mut browser = std::env::var("BROWSER_USE_BROWSER").ok().filter(|s| !s.is_empty());
    let mut snapshot: Option<(u16, u16)> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "-h" | "--help" => {
                print!("{HELP}");
                return ExitCode::SUCCESS;
            }
            "--browser" => browser = args.next(),
            // Hidden: render one frame as plain text, for UI work without a terminal.
            "--snapshot" => {
                snapshot = args.next().and_then(|v| {
                    let (w, h) = v.split_once('x')?;
                    Some((w.parse().ok()?, h.parse().ok()?))
                });
                if snapshot.is_none() {
                    eprintln!("tk: --snapshot needs WxH");
                    return ExitCode::from(2);
                }
            }
            _ => {
                eprintln!("tk: unknown argument {a} (tk -h)");
                return ExitCode::from(2);
            }
        }
    }
    let host = match bridge::pick(browser.as_deref()) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("tk: {e}");
            return ExitCode::FAILURE;
        }
    };
    let bg = ["TK_BG", "JV_BG"].iter().find_map(|k| std::env::var(k).ok().and_then(|s| Rgb::parse(&s))).unwrap_or(Rgb(0x28, 0x2c, 0x34));
    let mut app = match App::new(host, Palette::new(bg)) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("tk: {e}");
            return ExitCode::FAILURE;
        }
    };
    let res = match snapshot {
        Some((w, h)) => snapshot_frame(&mut app, w, h),
        None => run(&mut app),
    };
    match res {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("tk: {e}");
            ExitCode::FAILURE
        }
    }
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

fn snapshot_frame(app: &mut App, w: u16, h: u16) -> io::Result<()> {
    app.live = false;
    let mut term = Terminal::new(TestBackend::new(w, h)).map_err(io::Error::other)?;
    term.draw(|f| {
        let area = f.area();
        draw(app, area, f.buffer_mut());
    })
    .map_err(io::Error::other)?;
    let buf = term.backend().buffer();
    for y in 0..h {
        let row: String = (0..w).map(|x| buf[(x, y)].symbol().to_string()).collect();
        println!("{}", row.trim_end());
    }
    Ok(())
}

// ---- state -------------------------------------------------------------------

/// A row of the list: a window or tab-group heading, or a tab (its place in `view`).
enum Row {
    Header(String, Color),
    Tab(usize),
}

/// A close that finished: the tab, its title, and whether it worked.
type Done = (i64, String, Result<(), String>);

struct App {
    host: Host,
    pal: Palette,
    snap: Snap,
    /// Tabs shown, as indices into `snap.tabs`, in tab-strip order.
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
    /// A vim count being typed (5j, 12G).
    count: Option<u32>,
    /// Closed here and not yet gone from Chrome's list.
    closed: HashSet<i64>,
    msg: Option<(String, Instant)>,
    done_tx: Sender<Done>,
    done_rx: Receiver<Done>,
    fetched: Instant,
    /// False for --snapshot: nothing is closed or re-read.
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

    fn selected_id(&self) -> Option<i64> {
        self.view.get(self.cur).map(|&i| self.snap.tabs[i].id)
    }

    fn flash(&mut self, m: impl Into<String>) {
        self.msg = Some((m.into(), Instant::now()));
    }

    /// Recompute what's shown, keeping the cursor on tab `keep` when it's
    /// still there and on the same row otherwise.
    fn set_view(&mut self, keep: Option<i64>) {
        self.view = (0..self.snap.tabs.len()).filter(|&i| !self.closed.contains(&self.snap.tabs[i].id)).collect();
        let at = keep.and_then(|id| self.view.iter().position(|&i| self.snap.tabs[i].id == id));
        self.cur = at.unwrap_or(self.cur).min(self.view.len().saturating_sub(1));
    }

    fn refresh(&mut self) {
        self.fetched = Instant::now();
        match bridge::list(&self.host) {
            Ok(s) => {
                let keep = self.selected_id();
                self.snap = s;
                let live: HashSet<i64> = self.snap.tabs.iter().map(|t| t.id).collect();
                self.closed.retain(|id| live.contains(id));
                self.set_view(keep);
            }
            Err(e) => self.flash(e),
        }
    }

    /// Closes that finished, the flash running out, the list going stale.
    fn tick(&mut self) -> bool {
        let mut dirty = false;
        while let Ok((id, name, res)) = self.done_rx.try_recv() {
            match res {
                Ok(()) => self.flash(format!("closed {name}")),
                Err(e) => {
                    // Show it again: it's still open.
                    self.closed.remove(&id);
                    let keep = self.selected_id();
                    self.set_view(keep);
                    self.flash(format!("couldn't close {name}: {e}"));
                }
            }
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

    fn key(&mut self, k: KeyEvent) -> bool {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && k.code == KeyCode::Char('c') {
            return true;
        }
        if let KeyCode::Char(c @ '0'..='9') = k.code {
            if !ctrl && (c != '0' || self.count.is_some()) {
                self.count = Some((self.count.unwrap_or(0) * 10 + (c as u32 - '0' as u32)).min(99_999));
                return false;
            }
        }
        let count = self.count.take();
        let n = count.unwrap_or(1).max(1) as isize;
        let half = (self.list_h as isize / 2).max(1);
        match k.code {
            // Esc drops a half-typed count before it quits.
            KeyCode::Esc if count.is_some() => {}
            KeyCode::Esc | KeyCode::Char('q') => return true,
            KeyCode::Char('d') if ctrl => self.move_by(half),
            KeyCode::Char('u') if ctrl => self.move_by(-half),
            KeyCode::Char('n') if ctrl => self.move_by(n),
            KeyCode::Char('p') if ctrl => self.move_by(-n),
            KeyCode::Char('j') | KeyCode::Down => self.move_by(n),
            KeyCode::Char('k') | KeyCode::Up => self.move_by(-n),
            KeyCode::Char('g' | 'G') | KeyCode::Home | KeyCode::End if count.is_some() => self.move_by(n - 1 - self.cur as isize),
            KeyCode::Char('g') | KeyCode::Home => self.move_by(isize::MIN),
            KeyCode::Char('G') | KeyCode::End => self.move_by(isize::MAX),
            KeyCode::Char(';' | 'x') => self.close_selected(),
            _ => {}
        }
        false
    }

    fn move_by(&mut self, d: isize) {
        if self.view.is_empty() {
            return;
        }
        self.cur = (self.cur as isize).saturating_add(d).clamp(0, self.view.len() as isize - 1) as usize;
    }

    /// `;`: close the selected tab now, no questions. The cursor stays on its
    /// row, which is now the next tab.
    fn close_selected(&mut self) {
        let Some(t) = self.view.get(self.cur).map(|&i| &self.snap.tabs[i]) else { return };
        let (id, name) = (t.id, t.display_title().to_string());
        self.closed.insert(id);
        self.set_view(None);
        if self.live {
            let host = self.host.clone();
            let tx = self.done_tx.clone();
            std::thread::spawn(move || {
                let _ = tx.send((id, name, host.close(id)));
            });
        }
    }

    /// Window and group headings between the tabs, in tab-strip order.
    fn build_rows(&mut self) {
        self.rows.clear();
        let many_windows = self.snap.windows.len() > 1;
        let mut prev: Option<(i64, i64)> = None;
        for (k, &i) in self.view.iter().enumerate() {
            let t = &self.snap.tabs[i];
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
                let color = g.map_or(self.pal.muted, |g| group_color(&g.color));
                self.rows.push(Row::Header(title, color));
            }
            prev = Some((t.window, t.group));
            self.rows.push(Row::Tab(k));
        }
    }

    /// The box, centered, and the list scrolled so the cursor shows.
    fn layout(&mut self, area: Rect) -> Rect {
        self.build_rows();
        self.tall = self.tall.max(self.rows.len()).max(1);
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

// ---- drawing -----------------------------------------------------------------

fn draw(app: &mut App, area: Rect, buf: &mut Buffer) {
    let r = app.layout(area);
    let p = &app.pal;
    Clear.render(r, buf);
    let head = format!(" {} · {} tabs ", app.host.browser, app.view.len());
    let foot = if let Some((m, _)) = &app.msg {
        Line::from(Span::styled(format!(" {} ", truncate(m, r.width.saturating_sub(6) as usize)), fg(p.yellow)))
    } else if let Some(c) = app.count {
        Line::from(Span::styled(format!(" {c} "), fg(p.yellow)))
    } else {
        let mut spans = Vec::new();
        for (k, l) in [("j/k", "move"), (";", "close"), ("q", "quit")] {
            spans.push(Span::styled(format!("  {k}"), fg(p.muted)));
            spans.push(Span::styled(format!(" {l}"), fg(p.dim)));
        }
        spans.push(Span::raw(" "));
        Line::from(spans).right_aligned()
    };
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(fg(p.accent))
        .style(Style::new().bg(p.panel))
        .title(Line::styled(truncate(&head, r.width.saturating_sub(4) as usize), fg(p.muted)))
        .title_bottom(foot);
    let inner = block.inner(r);
    block.render(r, buf);

    let max = inner.right().saturating_sub(1);
    if app.view.is_empty() {
        put(buf, inner.x + 2, inner.y, max, "no tabs left", fg(p.dim));
        return;
    }
    let nw = app.view.len().to_string().len();
    for (i, row) in app.rows.iter().enumerate().skip(app.top).take(inner.height as usize) {
        let y = inner.y + (i - app.top) as u16;
        match row {
            Row::Header(text, color) => {
                put(buf, inner.x + 1, y, max, &truncate(text, max.saturating_sub(inner.x + 1) as usize), fg(*color).add_modifier(Modifier::BOLD));
            }
            Row::Tab(k) => tab_row(app, buf, inner, y, *k, nw),
        }
    }
}

fn tab_row(app: &App, buf: &mut Buffer, inner: Rect, y: u16, k: usize, nw: usize) {
    let p = &app.pal;
    let t = &app.snap.tabs[app.view[k]];
    let max = inner.right().saturating_sub(1);
    let on = k == app.cur;
    if on {
        buf.set_style(Rect::new(inner.x, y, inner.width, 1), Style::new().bg(p.sel));
    }
    // A stripe in the group's color down the edge of a group's tabs.
    if let Some(g) = app.snap.groups.get(&t.group) {
        put(buf, inner.x, y, max, "▎", fg(group_color(&g.color)));
    }
    // Relative numbers, as in jv: the cursor row its own number, the rest
    // their distance (5j gets there).
    let (n, nst) = if on { (k + 1, fg(p.yellow).add_modifier(Modifier::BOLD)) } else { (k.abs_diff(app.cur), fg(p.dim)) };
    let x = put(buf, inner.x + 1, y, max, &format!("{n:>nw$}"), nst) + 1;
    let (dot, dc) = if t.loading {
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
    // The site on the right when the title keeps over half the row.
    let avail = max.saturating_sub(x) as usize;
    let host = truncate_left(&t.host(), (avail / 3).clamp(12, 28));
    let show_host = avail >= host.width() + 2 + (avail * 11 / 20).max(14);
    let title_w = if show_host { avail - host.width() - 2 } else { avail };
    let tst = if on { fg(p.bright).add_modifier(Modifier::BOLD) } else { fg(p.fg) };
    put(buf, x, y, max, &truncate(t.display_title(), title_w), tst);
    if show_host {
        put(buf, max - host.width() as u16, y, max, &host, fg(p.dim));
    }
}

fn put(buf: &mut Buffer, x: u16, y: u16, max_x: u16, s: &str, st: Style) -> u16 {
    if x >= max_x || s.is_empty() {
        return x;
    }
    buf.set_stringn(x, y, s, (max_x - x) as usize, st).0
}

fn fg(c: Color) -> Style {
    Style::new().fg(c)
}

fn truncate(s: &str, w: usize) -> String {
    if s.width() <= w {
        return s.to_string();
    }
    if w == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut cw = 0;
    for c in s.chars() {
        let x = c.width().unwrap_or(0);
        if cw + x + 1 > w {
            break;
        }
        out.push(c);
        cw += x;
    }
    out.push('…');
    out
}

/// Keep the end: `…acme-4289.chatgpt.site`.
fn truncate_left(s: &str, w: usize) -> String {
    if s.width() <= w {
        return s.to_string();
    }
    let mut out: Vec<char> = Vec::new();
    let mut cw = 1;
    for c in s.chars().rev() {
        let x = c.width().unwrap_or(0);
        if cw + x > w {
            break;
        }
        out.push(c);
        cw += x;
    }
    out.push('…');
    out.into_iter().rev().collect()
}

// ---- colors ------------------------------------------------------------------
// jv's and ctab's (Zed's One Dark); tab groups in Chrome's dark-mode colors.

#[derive(Clone, Copy)]
struct Rgb(u8, u8, u8);

impl Rgb {
    fn parse(s: &str) -> Option<Rgb> {
        let s = s.trim().trim_start_matches('#');
        if s.len() != 6 {
            return None;
        }
        let v = u32::from_str_radix(s, 16).ok()?;
        Some(Rgb((v >> 16) as u8, (v >> 8) as u8, v as u8))
    }

    fn mix(self, o: Rgb, t: f32) -> Rgb {
        let f = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t).round().clamp(0.0, 255.0) as u8;
        Rgb(f(self.0, o.0), f(self.1, o.1), f(self.2, o.2))
    }

    fn c(self) -> Color {
        Color::Rgb(self.0, self.1, self.2)
    }
}

struct Palette {
    fg: Color,
    bright: Color,
    muted: Color,
    dim: Color,
    panel: Color,
    sel: Color,
    accent: Color,
    green: Color,
    yellow: Color,
}

impl Palette {
    fn new(bg: Rgb) -> Self {
        let fg = Rgb(0xab, 0xb2, 0xbf);
        let accent = Rgb(0x74, 0xad, 0xe8);
        Palette {
            fg: fg.c(),
            bright: Rgb(0xdc, 0xe0, 0xe5).c(),
            muted: bg.mix(fg, 0.62).c(),
            dim: bg.mix(fg, 0.40).c(),
            panel: bg.mix(fg, 0.055).c(),
            sel: bg.mix(accent, 0.24).c(),
            accent: accent.c(),
            green: Rgb(0x98, 0xc3, 0x79).c(),
            yellow: Rgb(0xe5, 0xc0, 0x7b).c(),
        }
    }
}

fn group_color(name: &str) -> Color {
    let (r, g, b) = match name {
        "grey" => (0xbd, 0xc1, 0xc6),
        "blue" => (0x8a, 0xb4, 0xf8),
        "red" => (0xf2, 0x8b, 0x82),
        "yellow" => (0xfd, 0xd6, 0x63),
        "green" => (0x81, 0xc9, 0x95),
        "pink" => (0xff, 0x8b, 0xcb),
        "purple" => (0xc5, 0x8a, 0xf9),
        "cyan" => (0x78, 0xd9, 0xec),
        "orange" => (0xfc, 0xad, 0x70),
        _ => (0xab, 0xb2, 0xbf),
    };
    Color::Rgb(r, g, b)
}
