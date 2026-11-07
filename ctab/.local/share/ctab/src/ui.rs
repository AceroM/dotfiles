//! Drawing, straight into the frame buffer, in the look of jv's `;` dialog:
//! the tabs on the left with relative numbers, the selected one on the right.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, BorderType, Clear, Widget};
use ratatui::Frame;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::app::{App, Mode, Row, Sort};
use crate::gfx;
use crate::theme::{group_color, Palette};

pub fn draw(app: &App, frame: &mut Frame) {
    let area = frame.area();
    let buf = frame.buffer_mut();
    list(app, buf);
    if let Some(r) = app.lay.preview {
        preview(app, buf, r);
    }
    status(app, buf);
    if app.mode == Mode::Help {
        help(app, buf, area);
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

// ---- the list --------------------------------------------------------------

fn list(app: &App, buf: &mut Buffer) {
    let p = &app.pal;
    let total = app.snap.tabs.len();
    let title = if app.filter.is_empty() {
        let order = if app.sort == Sort::Recent { " · recent first" } else { "" };
        format!("{} · {} tabs{order}", app.browser(), app.view.len())
    } else {
        format!("/{} · {} of {total}", app.filter, app.view.len())
    };
    let inner = panel(buf, app.lay.list, &title, p.accent, p);
    let max = inner.right().saturating_sub(1);
    if app.view.is_empty() {
        let why = if app.filter.is_empty() { "no tabs" } else { "no tab matches" };
        put(buf, inner.x + 2, inner.y, max, why, fg(p.dim));
        return;
    }
    let nw = app.view.len().to_string().len();
    let h = inner.height as usize;
    for (r, row) in app.rows.iter().enumerate().skip(app.list_top).take(h) {
        let y = inner.y + (r - app.list_top) as u16;
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
        fill(buf, Rect::new(inner.x, y, inner.width, 1), p.sel);
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

    // The site on the right (and the agent driving it), the title in what's left.
    let avail = max.saturating_sub(x) as usize;
    // Long hosts keep their end, the part that says whose site it is.
    let host = truncate_left(&t.host(), (avail / 3).clamp(12, 28));
    // The title comes first: the site shows only when the title keeps over
    // half the row, and the agent's name only when both fit.
    let fits = |rw: usize| avail >= rw + 2 + (avail * 11 / 20).max(14);
    let owner = t.owner_kind().map(|o| format!("{o} ")).filter(|o| fits(host.width() + o.width()));
    let right_w = host.width() + owner.as_ref().map_or(0, |o| o.width());
    let show_right = fits(right_w);
    let title_w = if show_right { avail - right_w - 2 } else { avail };
    let tst = if on { fg(p.bright).add_modifier(Modifier::BOLD) } else { fg(p.fg) };
    title(buf, x, y, max, t.display_title(), title_w, &app.hits[k], tst, p);
    if show_right {
        let mut rx = max - right_w as u16;
        if let Some(o) = &owner {
            rx = put(buf, rx, y, max, o, fg(p.accent));
        }
        put(buf, rx, y, max, &host, fg(p.dim));
    }
}

/// A title cut to `w` columns, the characters the filter matched in yellow.
#[allow(clippy::too_many_arguments)]
fn title(buf: &mut Buffer, x: u16, y: u16, max: u16, s: &str, w: usize, hits: &[usize], st: Style, p: &Palette) {
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
        put(buf, cx, y, max, "…", st);
    }
}

// ---- the preview -----------------------------------------------------------

fn preview(app: &App, buf: &mut Buffer, r: Rect) {
    let p = &app.pal;
    let head = app.selected().map(|t| t.url.clone()).unwrap_or_default();
    let inner = panel(buf, r, &head, p.border, p);
    let max = inner.right().saturating_sub(1);
    for (k, line) in app.plines.iter().take(inner.height as usize).enumerate() {
        let y = inner.y + k as u16;
        let mut x = inner.x + 1;
        for (s, st) in line {
            x = put(buf, x, y, max, s, fg(p.fg).patch(*st));
            if x >= max {
                break;
            }
        }
    }
    // The screenshot: each cell names its own row and column of the picture.
    if let Some(img) = &app.pimg {
        let x0 = inner.x + 1 + img.pad;
        for row in 0..img.rows.min(inner.height) {
            for c in 0..img.cols.min(max.saturating_sub(x0)) {
                if let Some(cell) = buf.cell_mut((x0 + c, inner.y + row)) {
                    gfx::placeholder(cell, img.id, row, c);
                }
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
    let hints: &[(&str, &str)] = if app.mode == Mode::Filter {
        &[("⏎", "go"), ("↑↓", "move"), ("esc", "keep filter"), ("^u", "clear")]
    } else {
        &[("⏎", "go"), ("x", "close"), ("/", "find"), ("s", "sort"), ("y", "copy url"), ("?", "keys"), ("q", "quit")]
    };
    let width: usize = hints.iter().map(|(k, l)| k.width() + l.width() + 3).sum();
    if (x as usize) + width + 2 > max as usize {
        return;
    }
    let mut hx = max - width as u16;
    for (k, l) in hints {
        hx = put(buf, hx, r.y, max, k, fg(p.muted));
        hx = put(buf, hx + 1, r.y, max, l, fg(p.dim)) + 2;
    }
}

// ---- ? ---------------------------------------------------------------------

const KEYS: &[(&str, &str)] = &[
    ("j k  ↓ ↑", "next / previous tab"),
    ("5j 3k 12G", "counts, by the relative numbers"),
    ("^d ^u", "half a list down / up"),
    ("g G", "first / last tab"),
    ("⏎", "go to the tab and quit"),
    ("o", "go to the tab, stay here"),
    ("x ;", "close the tab (;;; closes a run)"),
    ("/", "find by title or URL (⏎ goes)"),
    ("esc", "stop typing · clear the filter · quit"),
    ("s", "tab strip order / recently used"),
    ("y", "copy the URL"),
    ("r", "re-take the screenshot now"),
    ("click", "select · click again to go"),
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
