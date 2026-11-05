//! Drawing, straight into the frame buffer, in the look of jv's `;` dialog:
//! the tabs on the left with relative numbers, the selected one's pane (with
//! its own colors) on the right.

use std::ops::Range;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Clear, Widget};
use ratatui::Frame;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::agent;
use crate::app::{App, Mode};
use crate::herdr;
use crate::select;
use crate::theme::Palette;

pub fn draw(app: &App, frame: &mut Frame) {
    let area = frame.area();
    let buf = frame.buffer_mut();
    list(app, buf);
    if let Some(r) = app.lay.preview {
        preview(app, buf, r);
    }
    status(app, buf);
    match app.mode {
        Mode::Help => help(app, buf, area),
        Mode::Ask => ask(app, buf, area),
        _ => {}
    }
}

// ---- helpers -------------------------------------------------------------

fn put(buf: &mut Buffer, x: u16, y: u16, max_x: u16, s: &str, st: Style) -> u16 {
    if x >= max_x || s.is_empty() {
        return x;
    }
    buf.set_stringn(x, y, s, (max_x - x) as usize, st).0
}

fn fill(buf: &mut Buffer, r: Rect, bg: Color) {
    buf.set_style(r, Style::new().bg(bg));
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

/// Restyle the cells of `s` (already drawn at x) that fall in `hits`.
fn mark_hits(buf: &mut Buffer, x: u16, y: u16, max: u16, s: &str, hits: &[Range<usize>], st: Style) {
    let mut cx = x;
    for (i, c) in s.char_indices() {
        if cx >= max {
            break;
        }
        if hits.iter().any(|h| h.contains(&i)) {
            buf[(cx, y)].set_style(st);
        }
        cx += c.width().unwrap_or(0) as u16;
    }
}

fn panel(buf: &mut Buffer, r: Rect, title: &str, border: Color, p: &Palette) -> Rect {
    Clear.render(r, buf);
    let mut block = Block::bordered().border_type(BorderType::Rounded).border_style(fg(border)).style(Style::new().bg(p.panel));
    if !title.is_empty() {
        let t = truncate(title, r.width.saturating_sub(6) as usize);
        block = block.title(Line::styled(format!(" {t} "), fg(p.muted)));
    }
    let inner = block.inner(r);
    block.render(r, buf);
    inner
}

/// `s` cut to `w` columns at `x`, the characters at `hits` (char indices)
/// in yellow. Returns the column after it.
#[allow(clippy::too_many_arguments)]
fn text_with_hits(buf: &mut Buffer, x: u16, y: u16, max: u16, s: &str, w: usize, hits: &[usize], st: Style, p: &Palette) -> u16 {
    let cut = s.width() > w;
    let mut cx = x;
    let mut used = 0;
    for (i, c) in s.chars().enumerate() {
        let cw = c.width().unwrap_or(0);
        if used + cw + usize::from(cut) > w {
            break;
        }
        let cst = if hits.contains(&i) { st.fg(p.yellow).add_modifier(Modifier::BOLD) } else { st };
        cx = put(buf, cx, y, max, c.encode_utf8(&mut [0; 4]), cst);
        used += cw;
    }
    if cut && w > 0 {
        cx = put(buf, cx, y, max, "…", st);
    }
    cx
}

// ---- the list --------------------------------------------------------------

fn list(app: &App, buf: &mut Buffer) {
    let p = &app.pal;
    let title = if app.filter.is_empty() {
        app.space.clone()
    } else {
        format!("/{} · {} of {}", app.filter, app.view.len(), app.tabs.len())
    };
    let inner = panel(buf, app.lay.list, &title, p.accent, p);
    let max = inner.right().saturating_sub(1);
    if app.view.is_empty() {
        let why = if app.filter.is_empty() { "no other tabs" } else { "no tab matches" };
        put(buf, inner.x + 1, inner.y, max, why, fg(p.dim));
        return;
    }
    let nw = app.view.len().to_string().len();
    for (k, &i) in app.view.iter().enumerate().skip(app.list_top).take(inner.height as usize) {
        let t = &app.tabs[i];
        let y = inner.y + (k - app.list_top) as u16;
        let on = k == app.cur;
        if on {
            fill(buf, Rect::new(inner.x, y, inner.width, 1), p.sel);
        }
        // Relative numbers, as in jv's tree: the cursor row its own number,
        // the rest their distance (5j gets there).
        let (n, nst) = if on { (k + 1, fg(p.yellow).add_modifier(Modifier::BOLD)) } else { (k.abs_diff(app.cur), fg(p.dim)) };
        let x = put(buf, inner.x + 1, y, max, &format!("{n:>nw$}"), nst) + 1;
        let dot = match t.status.as_str() {
            "working" => p.yellow,
            "blocked" => p.red,
            "done" => p.green,
            "idle" => p.green_dim,
            _ => p.dim,
        };
        let x = put(buf, x, y, max, "●", fg(dot)) + 1;
        let (name_hits, title_hits) = &app.hits[k];
        let lst = if on { fg(p.bright).add_modifier(Modifier::BOLD) } else { fg(p.fg) };
        let x = text_with_hits(buf, x, y, max, t.name(), max.saturating_sub(x) as usize, name_hits, lst, p) + 2;
        if x < max {
            text_with_hits(buf, x, y, max, &t.title, (max - x) as usize, title_hits, fg(p.dim), p);
        }
    }
}

// ---- the preview -----------------------------------------------------------

fn preview(app: &App, buf: &mut Buffer, r: Rect) {
    let p = &app.pal;
    let mut title = app.selected().map(|t| herdr::tilde(&t.cwd)).unwrap_or_default();
    if app.in_transcript {
        title.push_str(" · transcript");
    }
    // Scrolled up: say how far from the bottom (d comes back down).
    let up = app.scroll.min(app.window(usize::MAX).len().saturating_sub(r.height.saturating_sub(2) as usize));
    if up > 0 {
        title.push_str(&format!(" · ↑{up}"));
    }
    let inner = panel(buf, r, &title, p.border, p);
    let max = inner.right().saturating_sub(1);
    let x0 = inner.x + 1;
    // Cells a..b of a line, as screen columns cut to the panel.
    let cells = |a: usize, b: usize| (x0 as usize).saturating_add(a).min(max as usize) as u16..(x0 as usize).saturating_add(b).min(max as usize) as u16;
    // The pane's latest lines (or the transcript's), bottom-aligned, like looking at it.
    let w = app.window(inner.height as usize);
    for (k, line) in app.lines()[w.clone()].iter().enumerate() {
        let (i, y) = (w.start + k, inner.y + k as u16);
        let mut x = x0;
        for (s, st) in line {
            x = put(buf, x, y, max, s, fg(p.fg).patch(*st));
            if x >= max {
                break;
            }
        }
        // Links underlined: ctrl-click opens them.
        for l in app.links.iter().filter(|l| l.line == i) {
            for x in cells(l.cols.start, l.cols.end) {
                buf[(x, y)].modifier.insert(Modifier::UNDERLINED);
            }
        }
        // The mark in reverse video, as Codex shows it: a line it runs on
        // past takes one cell more, for its line break.
        if let Some((a, b)) = app.sel.and_then(|s| s.cols(i)) {
            let tw = select::columns(&select::plain(line)).1;
            let hi = if b == select::EOL { tw + 1 } else { b.min(tw) };
            for x in cells(a.min(tw), hi) {
                buf[(x, y)].modifier.toggle(Modifier::REVERSED);
            }
        }
    }
}

// ---- the status line -------------------------------------------------------

fn status(app: &App, buf: &mut Buffer) {
    let p = &app.pal;
    let r = app.lay.status;
    if r.height == 0 {
        return;
    }
    let max = r.right();
    let mut x = r.x + 1;
    if app.mode == Mode::Filter {
        x = put(buf, x, r.y, max, "/", fg(p.accent));
        x = put(buf, x, r.y, max, &app.filter, fg(p.bright));
        x = put(buf, x, r.y, max, "▏", fg(p.accent));
    } else if let Some((m, _)) = &app.msg {
        x = put(buf, x, r.y, max, m, fg(p.yellow));
    } else if let Some(c) = app.count {
        x = put(buf, x, r.y, max, &c.to_string(), fg(p.yellow));
    } else if !app.filter.is_empty() {
        x = put(buf, x, r.y, max, &format!("/{} · esc clears", app.filter), fg(p.dim));
    }
    let hints: &[(&str, &str)] = match app.mode {
        Mode::Filter => &[("⏎", "go"), ("↑↓", "move"), ("esc", "keep filter"), ("^u", "clear")],
        Mode::Ask if app.ask_path.is_some() => &[("⏎", "send"), ("⇧⏎ ^j", "newline"), ("^v", "image"), ("tab", "path"), ("esc", "back")],
        Mode::Ask => &[("⏎", "send"), ("⇧⏎ ^j", "newline"), ("^v", "image"), ("esc", "back")],
        // Codex's footer while its transcript has a mark.
        _ if app.sel.is_some() => &[("^c", "copy"), ("⏎", "copy & follow"), ("esc", "clear")],
        _ => &[
            ("⏎", "go"),
            ("x", "close"),
            ("c", "new agent"),
            ("r", "reply"),
            ("d u", "scroll"),
            ("/", "find"),
            ("?", "keys"),
            ("q", "quit"),
        ],
    };
    // As many hints as fit, from the left.
    let room = (max as usize).saturating_sub(x as usize + 2);
    let mut take = hints.len();
    let width = |hs: &[(&str, &str)]| hs.iter().map(|(k, l)| k.width() + l.width() + 3).sum::<usize>();
    while take > 0 && width(&hints[..take]) > room {
        take -= 1;
    }
    let mut hx = max - width(&hints[..take]) as u16;
    for (k, l) in &hints[..take] {
        hx = put(buf, hx, r.y, max, k, fg(p.muted));
        hx = put(buf, hx + 1, r.y, max, l, fg(p.dim)) + 2;
    }
}

// ---- the agent box ---------------------------------------------------------

/// Screen rows of a prompt: each of its lines wrapped to `w` columns, as
/// byte ranges into `text`.
pub fn prompt_rows(text: &str, w: usize) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    for line in text.split('\n') {
        out.extend(wrap_ranges(line, w).into_iter().map(|r| start + r.start..start + r.end));
        start += line.len() + 1;
    }
    out
}

/// `text` broken into rows of at most `w` columns, as byte ranges.
fn wrap_ranges(text: &str, w: usize) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let (mut start, mut col) = (0, 0);
    for (i, c) in text.char_indices() {
        let cw = c.width().unwrap_or(0);
        if col + cw > w && col > 0 {
            out.push(start..i);
            start = i;
            col = 0;
        }
        col += cw;
    }
    out.push(start..text.len());
    out
}

/// The agent box's width on a screen `screen_w` wide.
fn ask_box_width(screen_w: u16) -> u16 {
    screen_w.saturating_sub(6).min(100)
}

/// The columns the agent box wraps its text to: inside the border, a column
/// of padding each side. ↑↓ in the box move by these rows.
pub fn ask_width(screen_w: u16) -> usize {
    (ask_box_width(screen_w) as usize).saturating_sub(4).max(8)
}

/// The agent box (`c`, or `r`), centered: a bordered input growing with its
/// text. The border says where it goes: a new agent's kind and folder, or
/// the tab a reply is for.
fn ask(app: &App, buf: &mut Buffer, area: Rect) {
    const MAX_ROWS: usize = 10;
    let p = &app.pal;
    let w = ask_box_width(area.width);
    if w < 20 || area.height < 3 {
        return;
    }
    let tw = ask_width(area.width);
    let field = &app.ask;
    let rows = prompt_rows(&field.text, tw);
    let shown = rows.len().clamp(1, MAX_ROWS).min(area.height as usize - 2);
    let h = shown as u16 + 2;
    let r = Rect::new(area.x + (area.width - w) / 2, area.y + (area.height - h) / 2, w, h);
    Clear.render(r, buf);
    let room = (w as usize).saturating_sub(16);
    let title = match &app.reply_to {
        Some(to) => vec![Span::styled(" reply to ", fg(p.muted)), Span::styled(truncate(&to.label, room), fg(p.accent)), Span::raw(" ")],
        None => {
            let kind = &app.ask_kind;
            let cwd = truncate(&herdr::tilde(&app.ask_cwd.to_string_lossy()), room.saturating_sub(kind.width() + 8));
            vec![
                Span::styled(" new ", fg(p.muted)),
                Span::styled(kind.clone(), fg(p.accent)),
                Span::styled(" in ", fg(p.muted)),
                Span::styled(cwd, fg(p.fg)),
                Span::raw(" "),
            ]
        }
    };
    Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(fg(p.dim))
        .style(Style::new().bg(p.panel))
        .title(Line::from(title))
        .render(r, buf);
    let (tx, y0, max) = (r.x + 2, r.y + 1, r.right().saturating_sub(2));

    // Cursor: on the last row starting at or before it. At a wrap point that's
    // the next row, so typing on carries on where the text will go.
    let cr = rows.iter().rposition(|r| r.start <= field.cur).unwrap_or(0);
    let top = cr.saturating_sub(shown - 1);
    let tags = agent::image_tags(&field.text);
    for (i, row) in rows.iter().enumerate().skip(top).take(shown) {
        let (y, s) = (y0 + (i - top) as u16, &field.text[row.clone()]);
        put(buf, tx, y, max, s, fg(p.bright));
        // `[Image #N]` tags in the accent color; a tag can wrap across rows.
        let hits: Vec<Range<usize>> = tags
            .iter()
            .filter(|(t, _)| t.start < row.end && t.end > row.start)
            .map(|(t, _)| t.start.max(row.start) - row.start..t.end.min(row.end) - row.start)
            .collect();
        mark_hits(buf, tx, y, max, s, &hits, fg(p.accent));
    }
    let cx = tx + field.text[rows[cr].start..field.cur].width() as u16;
    let cy = y0 + (cr - top) as u16;
    if cx <= max {
        let cell = &mut buf[(cx, cy)];
        if cell.symbol().trim().is_empty() {
            cell.set_symbol(" ");
        }
        cell.set_style(Style::new().fg(p.bg.c()).bg(p.accent));
    }
}

// ---- ? ---------------------------------------------------------------------

const KEYS: &[(&str, &str)] = &[
    ("j k  ↓ ↑", "next / previous tab"),
    ("5j 3k 12G", "counts, by the relative numbers · tab 12"),
    ("^d ^u", "half a list down / up"),
    ("g G", "first / last tab"),
    ("d u", "scroll the preview (a Claude tab's transcript above)"),
    ("⏎", "go to the tab and quit"),
    ("o", "go to the tab, stay open"),
    ("x ;", "close the tab (;;; closes a run)"),
    ("c", "ask a new agent, in a new tab"),
    ("r", "reply to the selected tab's agent"),
    ("  ^v ^j tab", "in the box: image · newline (⇧⏎ too) · --path"),
    ("/", "find by name, title or folder (⏎ goes)"),
    ("esc", "stop typing · clear the filter · quit"),
    ("click", "select · click again to go"),
    ("drag", "mark preview text · 2× a word · 3× a line"),
    ("^c y ⏎", "copy the mark (⏎ also back to the bottom)"),
    ("^click", "open a link: a URL, or code in Neovim"),
    ("q", "quit"),
];

fn help(app: &App, buf: &mut Buffer, area: Rect) {
    let p = &app.pal;
    let kw = KEYS.iter().map(|(k, _)| k.width()).max().unwrap_or(0);
    let lw = KEYS.iter().map(|(_, l)| l.width()).max().unwrap_or(0);
    let w = ((kw + lw + 7) as u16).min(area.width);
    let h = ((KEYS.len() + 2) as u16).min(area.height);
    let r = Rect::new(area.x + (area.width - w) / 2, area.y + (area.height - h) / 2, w, h);
    let inner = panel(buf, r, "keys · any key closes", p.accent, p);
    let max = inner.right();
    for (i, (k, l)) in KEYS.iter().enumerate().take(inner.height as usize) {
        let y = inner.y + i as u16;
        put(buf, inner.x + 1, y, max, k, fg(p.yellow));
        put(buf, inner.x + 3 + kw as u16, y, max, l, fg(p.fg));
    }
}
