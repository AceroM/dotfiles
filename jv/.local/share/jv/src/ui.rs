//! Drawing. Everything writes straight into the frame buffer so each cell's
//! colors are exact — no ANSI round-trip through delta.

use std::ops::Range;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, BorderType, Clear, Widget};
use ratatui::Frame;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::agent;
use crate::app::{App, Focus, Left, Mode};
use crate::diff::{Kind, Status};
use crate::doc::{self, Note, Row};
use crate::highlight::Tok;
use crate::prs::{self, Pr};
use crate::theme::Palette;
use crate::tree::{self, RowKind};

pub fn draw(app: &App, frame: &mut Frame) {
    let area = frame.area();
    let buf = frame.buffer_mut();
    top_bar(app, buf);
    if app.lay.tree.width > 0 {
        left_head(app, buf);
        if app.prs.is_some() && app.left == Left::Prs {
            pr_list(app, buf);
        } else {
            tree(app, buf);
        }
    }
    diff(app, buf);
    status(app, buf);
    match app.mode {
        Mode::Help => help(app, buf, area),
        Mode::GoTo => goto(app, buf, area),
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

/// A one-line input from `x`: its text, then the cursor, a bar past the end
/// or a block on the character it's on (where typing goes in).
fn input_line(buf: &mut Buffer, x: u16, y: u16, max_x: u16, f: &agent::Field, p: &Palette) {
    let end = put(buf, x, y, max_x, &f.text, fg(p.bright));
    if f.cur >= f.text.len() {
        put(buf, end, y, max_x, "▏", fg(p.accent));
        return;
    }
    let cx = x + f.text[..f.cur].width() as u16;
    if cx < max_x {
        buf[(cx, y)].set_style(Style::new().fg(p.bg.c()).bg(p.accent));
    }
}

fn fill(buf: &mut Buffer, r: Rect, bg: Color) {
    buf.set_style(r, Style::new().bg(bg));
}

/// GitHub's merged purple.
const MERGED: Color = Color::Rgb(0xc6, 0x78, 0xdd);

fn digits(n: usize) -> usize {
    n.max(1).ilog10() as usize + 1
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

/// Keep the end of a path: `…/api/routers/clients.ts`.
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

fn status_glyph(s: Status, p: &Palette) -> (&'static str, Color) {
    match s {
        Status::Modified => ("M", p.yellow),
        Status::Added => ("A", p.green),
        Status::Deleted => ("D", p.red),
        Status::Renamed => ("R", p.blue),
        Status::Copied => ("C", p.blue),
    }
}

fn stats(adds: usize, dels: usize, p: &Palette) -> Vec<(String, Color)> {
    let mut v = Vec::new();
    if adds > 0 {
        v.push((format!("+{adds}"), p.green_dim));
    }
    if dels > 0 {
        v.push((format!("{}-{dels}", if adds > 0 { " " } else { "" }), p.red_dim));
    }
    v
}

// ---- chrome --------------------------------------------------------------

fn top_bar(app: &App, buf: &mut Buffer) {
    let r = app.lay.top;
    if r.height == 0 {
        return;
    }
    let p = &app.pal;
    fill(buf, r, p.panel);
    let (n, adds, dels) = app.totals();
    let files = if app.filter_on() {
        format!("{n}/{} files  ", app.unfiltered)
    } else {
        format!("{n} file{}  ", if n == 1 { "" } else { "s" })
    };
    let st = stats(adds, dels, p);
    let rw = files.width() + st.iter().map(|(s, _)| s.width()).sum::<usize>() + 1;
    let rx = r.right().saturating_sub(rw as u16);
    let lmax = rx.saturating_sub(2);

    let name = if app.prs.is_some() { "jp" } else { "jv" };
    let mut x = put(buf, r.x + 1, r.y, lmax, name, fg(p.accent).add_modifier(Modifier::BOLD));
    x += 2;
    if let Some(m) = &app.meta {
        if let Some(pr) = app.prs.as_ref().filter(|p| p.all_repos()).and_then(|p| p.cur_item()) {
            x = put(buf, x, r.y, lmax, pr.repo.rsplit('/').next().unwrap_or(&pr.repo), fg(p.muted));
        }
        x = put(buf, x, r.y, lmax, &format!("#{} ", m.number), fg(p.muted));
        let tail = format!("  {} → {}  @{}", m.head, m.base, m.author);
        let badge = if m.draft {
            Some(("draft", p.muted))
        } else if m.state == "MERGED" {
            Some(("merged", MERGED))
        } else if m.state == "CLOSED" {
            Some(("closed", p.red))
        } else {
            None
        };
        let room = (lmax.saturating_sub(x) as usize).saturating_sub(tail.width() + badge.map_or(0, |b| b.0.len() + 2));
        x = put(buf, x, r.y, lmax, &truncate(&m.title, room.max(12)), fg(p.bright).add_modifier(Modifier::BOLD));
        if let Some((b, c)) = badge {
            x = put(buf, x + 2, r.y, lmax, b, fg(c));
        }
        x = put(buf, x + 2, r.y, lmax, &m.head, fg(p.muted));
        x = put(buf, x, r.y, lmax, " → ", fg(p.dim));
        x = put(buf, x, r.y, lmax, &m.base, fg(p.muted));
        put(buf, x + 2, r.y, lmax, &format!("@{}", m.author), fg(p.dim));
    } else {
        put(buf, x, r.y, lmax, &app.source.label(), fg(p.muted));
    }
    let mut x = put(buf, rx, r.y, r.right(), &files, fg(p.muted));
    for (s, c) in st {
        x = put(buf, x, r.y, r.right(), &s, fg(c));
    }
}

fn status(app: &App, buf: &mut Buffer) {
    let r = app.lay.status;
    if r.height == 0 {
        return;
    }
    let p = &app.pal;
    fill(buf, r, p.panel);
    let max = r.right();

    if app.mode == Mode::Filter {
        let mut x = put(buf, r.x + 1, r.y, max, "filter files ", fg(p.muted));
        x = put(buf, x, r.y, max, "❯ ", fg(p.accent).add_modifier(Modifier::BOLD));
        input_line(buf, x, r.y, max, &app.input, p);
        let info = format!("{}/{} files   ↑↓ move · enter keeps · esc cancels ", app.visible.len(), app.unfiltered);
        put(buf, max.saturating_sub(info.width() as u16), r.y, max, &info, fg(p.muted));
        return;
    }

    if app.mode == Mode::PrFilter {
        let mut x = put(buf, r.x + 1, r.y, max, "filter PRs ", fg(p.muted));
        x = put(buf, x, r.y, max, "❯ ", fg(p.accent).add_modifier(Modifier::BOLD));
        input_line(buf, x, r.y, max, &app.input, p);
        let (n, total) = app.prs.as_ref().map_or((0, 0), |p| (p.shown.len(), p.items.len()));
        let info = format!("{n}/{total} PRs   ↑↓ move · enter keeps · esc cancels ");
        put(buf, max.saturating_sub(info.width() as u16), r.y, max, &info, fg(p.muted));
        return;
    }

    if app.mode == Mode::Search {
        let x = put(buf, r.x + 1, r.y, max, "/", fg(p.accent).add_modifier(Modifier::BOLD));
        input_line(buf, x, r.y, max, &app.input, p);
        let info = match &app.search {
            Some(s) if !s.matches.is_empty() => format!("{}/{}", s.cur + 1, s.matches.len()),
            Some(_) => "no matches".into(),
            None => String::new(),
        };
        let info = format!("{info}   enter keeps · esc cancels ");
        put(buf, max.saturating_sub(info.width() as u16), r.y, max, &info, fg(p.muted));
        return;
    }

    let mut segs: Vec<(String, Color)> = Vec::new();
    if let Some(c) = app.count {
        segs.push((c.to_string(), p.accent));
    }
    if let Some(f) = app.prs.as_ref().map(|p| &p.filter).filter(|f| !f.is_empty()) {
        segs.push((format!("PRs: {f}"), p.accent));
    }
    if app.filter_on() {
        segs.push((format!("filter: {}", app.filter), p.accent));
    }
    if let Some(s) = &app.search {
        let cur = if s.matches.is_empty() { 0 } else { s.cur + 1 };
        segs.push((format!("/{}  {cur}/{}", s.query, s.matches.len()), p.yellow));
    }
    segs.push((if app.doc.geo.split { "split" } else { "unified" }.into(), p.muted));
    if !app.wrap {
        segs.push(("nowrap".into(), p.muted));
    }
    if app.hidden_tests > 0 {
        let n = app.hidden_tests;
        segs.push((format!("{n} test{} hidden", if n == 1 { "" } else { "s" }), p.muted));
    }
    let v = app.viewed_count();
    if v > 0 {
        segs.push((format!("✓ {v}/{}", app.visible.len()), p.green_dim));
    }
    segs.push((format!("{}%", app.percent()), p.muted));
    segs.push(("? help".into(), p.dim));
    let sep = "  ·  ";
    let rw: usize = segs.iter().map(|(s, _)| s.width()).sum::<usize>() + sep.len().saturating_sub(2) * (segs.len() - 1) + 1;
    let mut rx = max.saturating_sub(rw as u16);

    if let Some((m, _)) = &app.msg {
        // A message wins over the right-hand segments rather than being cut.
        if r.x + 1 + m.width() as u16 + 2 > rx {
            rx = max;
            segs.clear();
        }
        put(buf, r.x + 1, r.y, rx, m, fg(p.yellow));
    } else if let Some(f) = app.cur_file() {
        let file = &app.files[f];
        let pos = app.visible.iter().position(|&x| x == f).map_or(0, |i| i + 1);
        let mut x = put(buf, r.x + 1, r.y, rx, &format!("{pos}/{}  ", app.visible.len()), fg(p.dim));
        let room = rx.saturating_sub(x + 2) as usize;
        let path = truncate_left(&file.path, room);
        let (dir, name) = path.rsplit_once('/').map_or(("", path.as_str()), |(d, n)| (d, n));
        if !dir.is_empty() {
            x = put(buf, x, r.y, rx, dir, fg(p.muted));
            x = put(buf, x, r.y, rx, "/", fg(p.muted));
        }
        put(buf, x, r.y, rx, name, fg(p.fg));
    }
    let mut x = rx;
    for (i, (s, c)) in segs.iter().enumerate() {
        if i > 0 {
            x = put(buf, x, r.y, max, " · ", fg(p.dim));
        }
        x = put(buf, x, r.y, max, s, fg(*c));
    }
}

// ---- tree ----------------------------------------------------------------

fn tree(app: &App, buf: &mut Buffer) {
    let a = app.lay.tree;
    let p = &app.pal;
    fill(buf, a, p.panel);
    let s = app.lay.sep;
    for y in s.y..s.bottom() {
        put(buf, s.x, y, s.right(), "│", fg(p.border));
    }
    let cur = app.cur_file();
    let focused = app.focus == Focus::Tree;
    let max = a.right().saturating_sub(1);
    let nw = app.tree_nw;
    if app.tree_rows.is_empty() && app.filter_on() {
        put(buf, a.x + 2, a.y + 1, max, "No files match.", fg(p.muted));
        put(buf, a.x + 2, a.y + 2, max, "esc clears the filter", fg(p.dim));
        return;
    }
    let hit = fg(p.yellow).add_modifier(Modifier::BOLD);
    for (i, row) in app.tree_rows.iter().enumerate().skip(app.tree_top).take(a.height as usize) {
        let y = a.y + (i - app.tree_top) as u16;
        // Relative numbers like `set number relativenumber`: the cursor row
        // shows its own number, every other row its distance (5j gets there).
        let (n, nst) = if i == app.tree_cur {
            fill(buf, Rect::new(a.x, y, a.width, 1), if focused { p.sel } else { p.sel_dim });
            (i + 1, fg(if focused { p.yellow } else { p.muted }).add_modifier(Modifier::BOLD))
        } else {
            (i.abs_diff(app.tree_cur), fg(p.dim))
        };
        put(buf, a.x + 1, y, max, &format!("{n:>nw$}"), nst);
        let mut x = a.x + nw as u16 + 2 + row.depth * 2;
        match &row.kind {
            RowKind::Dir { name, open, .. } => {
                x = put(buf, x, y, max, if *open { "▾ " } else { "▸ " }, fg(p.dim));
                let shown = truncate(name, max.saturating_sub(x) as usize);
                put(buf, x, y, max, &shown, fg(p.muted));
                mark_hits(buf, x, y, max, &shown, &tree::hits(&app.filter, name), hit);
            }
            RowKind::File { idx, name } => {
                let f = &app.files[*idx];
                let viewed = app.viewed.has(f.hash);
                let (g, gc) = if viewed { ("✓", p.green_dim) } else { status_glyph(f.status, p) };
                x = put(buf, x, y, max, g, fg(gc).add_modifier(Modifier::BOLD)) + 1;
                let st = stats(f.adds, f.dels, p);
                let sw: usize = st.iter().map(|(s, _)| s.width()).sum();
                let room = (max.saturating_sub(x) as usize).saturating_sub(sw + 1);
                let style = if viewed {
                    fg(p.dim)
                } else if cur == Some(*idx) {
                    fg(p.bright).add_modifier(Modifier::BOLD)
                } else {
                    fg(p.fg)
                };
                let shown = truncate(name, room);
                put(buf, x, y, max, &shown, style);
                mark_hits(buf, x, y, max, &shown, &tree::hits(&app.filter, name), hit);
                let mut sx = max.saturating_sub(sw as u16);
                for (s, c) in st {
                    sx = put(buf, sx, y, max, &s, fg(if viewed { p.dim } else { c }));
                }
            }
        }
    }
}

// ---- PR list (jp) ----------------------------------------------------------

/// The row over jp's left pane: what the list shows, or the way back to it.
fn left_head(app: &App, buf: &mut Buffer) {
    let r = app.lay.head;
    let Some(pane) = app.prs.as_ref().filter(|_| r.height > 0) else { return };
    let p = &app.pal;
    fill(buf, r, p.panel);
    let max = r.right().saturating_sub(1);
    if app.left == Left::Prs {
        let n = if pane.filter_on() { format!("{}/{}", pane.shown.len(), pane.items.len()) } else { pane.items.len().to_string() };
        let right = if pane.refreshing() { format!("↻ {n}") } else { n };
        let rx = max.saturating_sub(right.width() as u16);
        let label = truncate(&pane.query.label(), rx.saturating_sub(r.x + 2) as usize);
        put(buf, r.x + 1, r.y, rx, &label, fg(p.muted).add_modifier(Modifier::BOLD));
        put(buf, rx, r.y, max, &right, fg(p.dim));
        return;
    }
    let mut x = put(buf, r.x + 1, r.y, max, "‹ PRs", fg(p.accent).add_modifier(Modifier::BOLD));
    if let Some(m) = &app.meta {
        x = put(buf, x + 2, r.y, max, &format!("#{}", m.number), fg(p.muted));
    }
    let n = app.visible.len();
    put(buf, x + 2, r.y, max, &format!("{n} file{}", if n == 1 { "" } else { "s" }), fg(p.dim));
}

fn pr_glyph(pr: &Pr, p: &Palette) -> (&'static str, Color) {
    match pr.state.as_str() {
        "MERGED" => ("●", MERGED),
        "CLOSED" => ("●", p.red),
        _ if pr.draft => ("○", p.muted),
        _ => ("●", p.green),
    }
}

/// Two rows per PR: its title, then number, state, age, checks, review,
/// how much of it you've viewed, and its size.
fn pr_list(app: &App, buf: &mut Buffer) {
    let a = app.lay.tree;
    let p = &app.pal;
    fill(buf, a, p.panel);
    let s = app.lay.sep;
    for y in s.y..s.bottom() {
        put(buf, s.x, y, s.right(), "│", fg(p.border));
    }
    let Some(pane) = &app.prs else { return };
    let max = a.right().saturating_sub(1);
    if pane.shown.is_empty() {
        let (l1, l2) = if pane.filter_on() { ("No PRs match.", "esc clears the filter") } else { ("No PRs.", "R searches again") };
        put(buf, a.x + 2, a.y + 1, max, l1, fg(p.muted));
        put(buf, a.x + 2, a.y + 2, max, l2, fg(p.dim));
        return;
    }
    let focused = app.focus == Focus::Tree;
    let nw = digits(pane.shown.len()).max(2);
    let now = prs::now();
    let hit = fg(p.yellow).add_modifier(Modifier::BOLD);
    let rows = (a.height as usize / 2).max(1);
    for (i, &ix) in pane.shown.iter().enumerate().skip(pane.top).take(rows) {
        let y = a.y + ((i - pane.top) * 2) as u16;
        if y >= a.bottom() {
            break;
        }
        let pr = &pane.items[ix];
        let cur = i == pane.cur;
        // Relative numbers, as in the tree: 5j lands on the row marked 5.
        let (n, nst) = if cur {
            fill(buf, Rect::new(a.x, y, a.width, 2.min(a.bottom() - y)), if focused { p.sel } else { p.sel_dim });
            (i + 1, fg(if focused { p.yellow } else { p.muted }).add_modifier(Modifier::BOLD))
        } else {
            (i.abs_diff(pane.cur), fg(p.dim))
        };
        put(buf, a.x + 1, y, max, &format!("{n:>nw$}"), nst);
        let (g, gc) = pr_glyph(pr, p);
        let x = put(buf, a.x + nw as u16 + 2, y, max, g, fg(gc).add_modifier(Modifier::BOLD)) + 1;
        let viewed = app.pr_viewed(pr);
        let done = viewed.is_some_and(|(v, n)| n > 0 && v == n);
        let st = if cur {
            fg(p.bright).add_modifier(Modifier::BOLD)
        } else if done {
            fg(p.muted)
        } else {
            fg(p.fg)
        };
        let title = truncate(&pr.title, max.saturating_sub(x) as usize);
        put(buf, x, y, max, &title, st);
        mark_hits(buf, x, y, max, &title, &tree::hits(&pane.filter, &title), hit);
        if y + 1 < a.bottom() {
            pr_info(app, buf, x, y + 1, max, pr, viewed, now);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn pr_info(app: &App, buf: &mut Buffer, x: u16, y: u16, max: u16, pr: &Pr, viewed: Option<(usize, usize)>, now: i64) {
    let p = &app.pal;
    let mut segs: Vec<(String, Color)> = Vec::new();
    let all = app.prs.as_ref().is_some_and(|p| p.all_repos());
    let repo = if all { pr.repo.rsplit('/').next().unwrap_or(&pr.repo) } else { "" };
    segs.push((format!("{repo}#{}", pr.number), p.muted));
    match pr.state.as_str() {
        "MERGED" => segs.push(("merged".into(), MERGED)),
        "CLOSED" => segs.push(("closed".into(), p.red)),
        _ if pr.draft => segs.push(("draft".into(), p.muted)),
        _ => {}
    }
    segs.push((prs::age(pr.updated, now), p.dim));
    // Checks and reviews only matter until it's merged or closed.
    if pr.open() {
        match pr.ci.as_deref() {
            Some("SUCCESS") => segs.push(("ci ✓".into(), p.green_dim)),
            Some("FAILURE" | "ERROR") => segs.push(("ci ✗".into(), p.red)),
            Some("PENDING" | "EXPECTED") => segs.push(("ci ●".into(), p.yellow)),
            _ => {}
        }
        match pr.review.as_str() {
            "APPROVED" => segs.push(("approved".into(), p.green_dim)),
            "CHANGES_REQUESTED" => segs.push(("changes requested".into(), p.red)),
            "REVIEW_REQUIRED" => segs.push(("needs review".into(), p.dim)),
            _ => {}
        }
    }
    if let Some((v, n)) = viewed.filter(|&(v, _)| v > 0) {
        segs.push((if v == n { "✓ viewed".into() } else { format!("✓ {v}/{n}") }, p.green_dim));
    }
    let st = stats(pr.adds, pr.dels, p);
    let sw: usize = st.iter().map(|(s, _)| s.width()).sum();
    let lmax = max.saturating_sub(sw as u16 + 2);
    let mut cx = x;
    for (i, (s, c)) in segs.iter().enumerate() {
        let gap = if i > 0 { 2 } else { 0 };
        // A segment shows whole or not at all.
        if cx + gap + s.width() as u16 > lmax {
            break;
        }
        cx = put(buf, cx + gap, y, lmax, s, fg(*c));
    }
    let mut sx = max.saturating_sub(sw as u16);
    if sx > cx {
        for (s, c) in st {
            sx = put(buf, sx, y, max, &s, fg(c));
        }
    }
}

// ---- diff ----------------------------------------------------------------

fn diff(app: &App, buf: &mut Buffer) {
    let a = app.lay.diff;
    let p = &app.pal;
    if a.width < 12 || a.height == 0 {
        return;
    }
    if let Some(msg) = app.pr_placeholder() {
        put(buf, a.x + 3, a.y + 1, a.right(), &msg, fg(p.muted));
        return;
    }
    if app.visible.is_empty() {
        let msg = if app.filter_on() && app.hidden_tests > 0 {
            format!("Only test files match \"{}\". T shows the {} hidden; esc clears the filter.", app.filter, app.hidden_tests)
        } else if app.filter_on() {
            format!("No files match \"{}\". Esc clears the filter.", app.filter)
        } else if app.hidden_tests > 0 {
            format!("Only test files changed. T shows the {} hidden.", app.hidden_tests)
        } else {
            "No files in this diff.".to_string()
        };
        put(buf, a.x + 3, a.y + 1, a.right(), &msg, fg(p.muted));
        return;
    }
    let cw = a.width - 1;
    for y in 0..a.height {
        let i = app.scroll + y as usize;
        let Some(row) = app.doc.rows.get(i) else { break };
        draw_row(app, buf, Rect::new(a.x, a.y + y, cw, 1), *row);
        if let Some(cols) = app.sel_cols(i) {
            for x in cols.start..cols.end.min(cw) {
                buf[(a.x + x, a.y + y)].set_bg(p.sel_text);
            }
        }
    }
    if let Some(f) = app.sticky() {
        let r = Rect::new(a.x, a.y, cw, 1);
        for x in r.x..r.right() {
            buf[(x, r.y)].reset();
        }
        file_header(app, buf, r, f);
    }
    scrollbar(app, buf, Rect::new(a.x + cw, a.y, 1, a.height));
}

fn draw_row(app: &App, buf: &mut Buffer, r: Rect, row: Row) {
    match row {
        Row::File { f } => file_header(app, buf, r, f as usize),
        Row::Note { f, note } => note_row(app, buf, r, f as usize, note),
        Row::Hunk { f, h } => hunk_row(app, buf, r, f as usize, h as usize),
        Row::Uni { f, h, l, seg } => uni_row(app, buf, r, f as usize, h as usize, l as usize, seg as usize),
        Row::Split { f, h, p, seg } => split_row(app, buf, r, f as usize, h as usize, p as usize, seg as usize),
        Row::Blank => {}
    }
}

fn file_header(app: &App, buf: &mut Buffer, r: Rect, f: usize) {
    let p = &app.pal;
    let file = &app.files[f];
    fill(buf, r, p.panel);
    let max = r.right();

    let mut right: Vec<(String, Style)> = Vec::new();
    if file.is_test {
        right.push(("test".into(), fg(p.dim)));
    }
    if app.viewed.has(file.hash) {
        right.push(("✓ Viewed".into(), fg(p.green)));
    }
    if let Some(i) = app.visible.iter().position(|&x| x == f) {
        right.push((format!("{}/{}", i + 1, app.visible.len()), fg(p.dim)));
    }
    let rw: usize = right.iter().map(|(s, _)| s.width() + 2).sum();
    let lmax = max.saturating_sub(rw as u16 + 1);

    let mut x = put(buf, r.x + 1, r.y, lmax, if app.is_collapsed(f) { "▸ " } else { "▾ " }, fg(p.dim));
    let (g, gc) = status_glyph(file.status, p);
    x = put(buf, x, r.y, lmax, g, fg(gc).add_modifier(Modifier::BOLD)) + 1;
    if let (Some(old), Status::Renamed | Status::Copied) = (&file.old_path, file.status) {
        x = put(buf, x, r.y, lmax, old, fg(p.muted));
        x = put(buf, x, r.y, lmax, " → ", fg(p.dim));
    }
    let st = stats(file.adds, file.dels, p);
    let sw: usize = st.iter().map(|(s, _)| s.width()).sum::<usize>() + 2;
    let path = truncate_left(&file.path, (lmax.saturating_sub(x) as usize).saturating_sub(sw));
    let (dir, name) = match path.rfind('/') {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path.as_str()),
    };
    x = put(buf, x, r.y, lmax, dir, fg(p.muted));
    x = put(buf, x, r.y, lmax, name, fg(p.bright).add_modifier(Modifier::BOLD)) + 2;
    for (s, c) in st {
        x = put(buf, x, r.y, lmax, &s, fg(c));
    }
    let mut rx = max.saturating_sub(rw as u16);
    if rx > x {
        for (s, st) in right {
            rx = put(buf, rx, r.y, max, &s, st) + 2;
        }
    }
}

fn note_row(app: &App, buf: &mut Buffer, r: Rect, f: usize, note: Note) {
    let file = &app.files[f];
    let n = file.line_count();
    let text = match note {
        Note::Binary => "Binary file not shown".to_string(),
        Note::Collapsed => format!("{n} lines folded · z unfolds"),
        Note::Viewed => format!("Viewed · {n} lines folded · z unfolds · x unmarks"),
        Note::Large => {
            format!("{n} lines folded ({}) · z unfolds", if file.generated { "generated file" } else { "large diff" })
        }
        Note::ModeOnly => format!("Mode changed {} → {}", file.mode.0, file.mode.1),
        Note::RenameOnly => "Renamed without changes".to_string(),
        Note::Empty => "No content changes".to_string(),
    };
    put(buf, r.x + 4, r.y, r.right(), &text, fg(app.pal.dim).add_modifier(Modifier::ITALIC));
}

fn hunk_row(app: &App, buf: &mut Buffer, r: Rect, f: usize, h: usize) {
    let p = &app.pal;
    let hk = &app.files[f].hunks[h];
    fill(buf, r, p.hunk_bg);
    let label = format!("@@ -{},{} +{},{} @@", hk.old_start, hk.old_len, hk.new_start, hk.new_len);
    let x = put(buf, r.x + 1, r.y, r.right(), &label, fg(p.hunk_fg));
    if !hk.context.is_empty() {
        put(buf, x + 2, r.y, r.right(), &hk.context, fg(p.muted));
    }
}

struct KindStyle {
    bg: Option<Color>,
    gutter: Option<Color>,
    nr: Color,
    sign: &'static str,
    emph: Option<Color>,
}

/// `soft`: the whole file is one-sided (new or deleted), so every line is an
/// addition and a full-strength tint would carry no information.
fn kind_style(p: &Palette, k: Kind, soft: bool) -> KindStyle {
    match k {
        Kind::Ctx => KindStyle { bg: None, gutter: None, nr: p.line_nr, sign: " ", emph: None },
        Kind::Add => KindStyle {
            bg: Some(if soft { p.add_bg_soft } else { p.add_bg }),
            gutter: Some(p.add_gutter),
            nr: p.add_nr,
            sign: "+",
            emph: Some(p.add_emph),
        },
        Kind::Del => KindStyle {
            bg: Some(if soft { p.del_bg_soft } else { p.del_bg }),
            gutter: Some(p.del_gutter),
            nr: p.del_nr,
            sign: "-",
            emph: Some(p.del_emph),
        },
    }
}

fn num(n: u32, w: usize) -> String {
    if n == 0 {
        " ".repeat(w)
    } else {
        format!("{n:>w$}")
    }
}

/// The line `{n}G` landed on gets an accent number and a `▸` in the gutter.
fn nr_style(app: &App, at: (usize, usize, usize), nr: Color) -> Style {
    if app.mark == Some(at) {
        fg(app.pal.accent).add_modifier(Modifier::BOLD)
    } else {
        fg(nr)
    }
}

fn mark_arrow(app: &App, buf: &mut Buffer, r: Rect, at: (usize, usize, usize)) {
    if app.mark == Some(at) {
        put(buf, r.x, r.y, r.right(), "▸", fg(app.pal.accent));
    }
}

fn uni_row(app: &App, buf: &mut Buffer, r: Rect, f: usize, h: usize, l: usize, seg: usize) {
    let geo = &app.doc.geo;
    let file = &app.files[f];
    let line = &file.hunks[h].lines[l];
    let single = file.one_sided();
    let k = kind_style(&app.pal, line.kind, single);
    if let Some(bg) = k.bg {
        fill(buf, r, bg);
    }
    let gw = if single { geo.gutter1() } else { geo.gutter2() } as u16;
    if let Some(g) = k.gutter {
        fill(buf, Rect::new(r.x, r.y, gw.min(r.width), 1), g);
    }
    let max = r.right();
    if seg == 0 {
        let nums = if single {
            format!(" {} ", num(if line.kind == Kind::Del { line.old } else { line.new }, geo.nw))
        } else {
            format!(" {} {} ", num(line.old, geo.nw), num(line.new, geo.nw))
        };
        put(buf, r.x, r.y, max, &nums, nr_style(app, (f, h, l), k.nr));
        put(buf, r.x + gw, r.y, max, k.sign, fg(k.nr));
        mark_arrow(app, buf, r, (f, h, l));
    }
    code(app, buf, r.x + gw + 2, r.y, max, (f, h, l), seg, geo.uni_code_w(single), k.emph);
}

fn split_row(app: &App, buf: &mut Buffer, r: Rect, f: usize, h: usize, p: usize, seg: usize) {
    let geo = &app.doc.geo;
    let (lo, ro) = app.files[f].hunks[h].pairs[p];
    let (lw, rw) = (geo.left_w() as u16, geo.right_w() as u16);
    side(app, buf, Rect::new(r.x, r.y, lw, 1), (f, h), lo, seg, false);
    put(buf, r.x + lw, r.y, r.right(), "│", fg(app.pal.border));
    side(app, buf, Rect::new(r.x + lw + 1, r.y, rw, 1), (f, h), ro, seg, true);
}

fn side(app: &App, buf: &mut Buffer, r: Rect, (f, h): (usize, usize), l: Option<usize>, seg: usize, right: bool) {
    let p = &app.pal;
    let geo = &app.doc.geo;
    let Some(l) = l else {
        fill(buf, r, p.filler);
        return;
    };
    let line = &app.files[f].hunks[h].lines[l];
    let k = kind_style(p, line.kind, false);
    if let Some(bg) = k.bg {
        fill(buf, r, bg);
    }
    let gw = geo.gutter1() as u16;
    if let Some(g) = k.gutter {
        fill(buf, Rect::new(r.x, r.y, gw.min(r.width), 1), g);
    }
    if seg == 0 {
        let n = if right { line.new } else { line.old };
        put(buf, r.x, r.y, r.right(), &format!(" {} ", num(n, geo.nw)), nr_style(app, (f, h, l), k.nr));
        put(buf, r.x + gw, r.y, r.right(), k.sign, fg(k.nr));
        mark_arrow(app, buf, r, (f, h, l));
    }
    code(app, buf, r.x + gw + 2, r.y, r.right(), (f, h, l), seg, geo.side_code_w(right), k.emph);
}

#[allow(clippy::too_many_arguments)]
fn code(
    app: &App,
    buf: &mut Buffer,
    x: u16,
    y: u16,
    max: u16,
    (f, h, l): (usize, usize, usize),
    seg: usize,
    w: usize,
    emph_bg: Option<Color>,
) {
    let p = &app.pal;
    let line = &app.files[f].hunks[h].lines[l];
    let toks: &[Tok] = app.hl_cache.get(&f).and_then(|x| x.get(h)).and_then(|x| x.get(l)).map_or(&[], |v| v.as_slice());
    let search = app.search_ranges(f, h, l);
    let runs = runs(&line.text, toks, &line.emph, emph_bg, &search, p);
    let max = max.min(x.saturating_add(w as u16));
    let end = if app.wrap {
        let segs = doc::wrap_ranges(&line.text, w);
        let Some(sr) = segs.get(seg) else { return };
        let end = write_runs(buf, x, y, max, &line.text, &runs, sr.clone(), 0);
        (seg + 1 == segs.len()).then_some(end)
    } else if seg == 0 {
        let end = write_runs(buf, x, y, max, &line.text, &runs, 0..line.text.len(), app.hscroll);
        if line.text.width() > app.hscroll + w {
            put(buf, max.saturating_sub(1), y, max, "›", fg(p.muted));
        }
        Some(end)
    } else {
        None
    };
    if let (Some(end), true) = (end, line.no_eol) {
        put(buf, end + 1, y, max, "⊘ no newline", fg(p.dim).add_modifier(Modifier::ITALIC));
    }
}

/// Split `text` into styled runs: syntax colors, then the changed-word
/// background, then search hits on top.
fn runs(
    text: &str,
    toks: &[Tok],
    emph: &[Range<usize>],
    emph_bg: Option<Color>,
    search: &[(Range<usize>, bool)],
    p: &Palette,
) -> Vec<(Range<usize>, Style)> {
    let n = text.len();
    let mut cuts = vec![0, n];
    for t in toks {
        cuts.extend([t.range.start.min(n), t.range.end.min(n)]);
    }
    if emph_bg.is_some() {
        for e in emph {
            cuts.extend([e.start.min(n), e.end.min(n)]);
        }
    }
    for (s, _) in search {
        cuts.extend([s.start.min(n), s.end.min(n)]);
    }
    cuts.sort_unstable();
    cuts.dedup();
    let mut out = Vec::with_capacity(cuts.len());
    let mut ti = 0;
    for w in cuts.windows(2) {
        let (a, b) = (w[0], w[1]);
        if a >= b {
            continue;
        }
        while ti < toks.len() && toks[ti].range.end <= a {
            ti += 1;
        }
        let mut st = Style::new().fg(p.fg);
        if let Some(t) = toks.get(ti).filter(|t| t.range.start <= a) {
            st = st.fg(t.fg);
            if t.bold {
                st = st.add_modifier(Modifier::BOLD);
            }
            if t.italic {
                st = st.add_modifier(Modifier::ITALIC);
            }
        }
        if let Some(bg) = emph_bg {
            if emph.iter().any(|e| e.start <= a && a < e.end) {
                st = st.bg(bg);
            }
        }
        if let Some((_, cur)) = search.iter().find(|(s, _)| s.start <= a && a < s.end) {
            st = if *cur { st.bg(p.search_cur_bg).fg(p.search_cur_fg) } else { st.bg(p.search_bg) };
        }
        out.push((a..b, st));
    }
    out
}

/// Write the part of `runs` inside `range`, skipping the first `skip` columns.
/// Returns the x after the last cell written.
#[allow(clippy::too_many_arguments)]
fn write_runs(
    buf: &mut Buffer,
    x: u16,
    y: u16,
    max: u16,
    text: &str,
    runs: &[(Range<usize>, Style)],
    range: Range<usize>,
    skip: usize,
) -> u16 {
    let mut cx = x;
    let mut col = 0;
    for (r, st) in runs {
        let (a, b) = (r.start.max(range.start), r.end.min(range.end));
        if a >= b {
            continue;
        }
        let mut chunk = String::new();
        for c in text[a..b].chars() {
            let cw = c.width().unwrap_or(0);
            if col < skip {
                col += cw;
                if col > skip {
                    chunk.push(' ');
                }
                continue;
            }
            col += cw;
            chunk.push(c);
        }
        if !chunk.is_empty() {
            cx = put(buf, cx, y, max, &chunk, *st);
            if cx >= max {
                break;
            }
        }
    }
    cx
}

fn scrollbar(app: &App, buf: &mut Buffer, r: Rect) {
    let h = r.height as usize;
    let max = app.max_scroll();
    if max == 0 || h == 0 {
        return;
    }
    let thumb = (h * h / (max + h)).clamp(1, h);
    let pos = app.scroll * (h - thumb) / max;
    for y in pos..pos + thumb {
        put(buf, r.x, r.y + y as u16, r.right(), "┃", fg(app.pal.dim));
    }
}

// ---- overlays ------------------------------------------------------------

fn popup(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width.saturating_sub(4));
    let h = h.min(area.height.saturating_sub(2));
    Rect::new(area.x + (area.width - w) / 2, area.y + (area.height - h) / 3, w, h)
}

fn frame(buf: &mut Buffer, r: Rect, title: &str, p: &Palette) -> Rect {
    Clear.render(r, buf);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(fg(p.dim))
        .title(Line::styled(format!(" {title} "), fg(p.muted)))
        .style(Style::new().bg(p.panel));
    let inner = block.inner(r);
    block.render(r, buf);
    inner
}

fn goto(app: &App, buf: &mut Buffer, area: Rect) {
    let p = &app.pal;
    let r = popup(area, 100, 26);
    if r.width < 24 || r.height < 6 {
        return;
    }
    let inner = frame(buf, r, "Go to file", p);
    let max = inner.right().saturating_sub(1);
    let x = put(buf, inner.x + 1, inner.y, max, "❯ ", fg(p.accent));
    input_line(buf, x, inner.y, max, &app.input, p);
    let count = format!("{}/{}", app.goto.len(), app.files.len());
    put(buf, max.saturating_sub(count.width() as u16), inner.y, max, &count, fg(p.dim));

    let list_h = inner.height.saturating_sub(2) as usize;
    let start = app.goto_cur.saturating_sub(list_h.saturating_sub(1));
    for (k, (fi, pos)) in app.goto.iter().enumerate().skip(start).take(list_h) {
        let y = inner.y + 2 + (k - start) as u16;
        if k == app.goto_cur {
            fill(buf, Rect::new(inner.x, y, inner.width, 1), p.sel);
        }
        let f = &app.files[*fi];
        let (g, gc) = status_glyph(f.status, p);
        let mut x = put(buf, inner.x + 1, y, max, g, fg(gc).add_modifier(Modifier::BOLD)) + 1;
        let tag = if !tree::matches(&app.filter, &f.path) {
            "filtered out".to_string()
        } else if f.is_test && !app.show_tests {
            "hidden test".to_string()
        } else {
            String::new()
        };
        let st = stats(f.adds, f.dels, p);
        let rw = if tag.is_empty() { st.iter().map(|(s, _)| s.width()).sum::<usize>() } else { tag.width() };
        let pmax = max.saturating_sub(rw as u16 + 2);
        let name_start = f.path.rfind('/').map_or(0, |i| f.path[..=i].chars().count());
        for (ci, ch) in f.path.chars().enumerate() {
            let st = if pos.contains(&ci) {
                fg(p.accent).add_modifier(Modifier::BOLD)
            } else if ci >= name_start {
                fg(p.bright)
            } else {
                fg(p.muted)
            };
            x = put(buf, x, y, pmax, ch.encode_utf8(&mut [0; 4]), st);
        }
        let mut sx = max.saturating_sub(rw as u16);
        if tag.is_empty() {
            for (s, c) in st {
                sx = put(buf, sx, y, max, &s, fg(c));
            }
        } else {
            put(buf, sx, y, max, &tag, fg(p.dim));
        }
    }
}

/// Screen rows of a prompt: each of its lines wrapped to `w` columns, as
/// byte ranges into `text`.
pub fn prompt_rows(text: &str, w: usize) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    for line in text.split('\n') {
        out.extend(doc::wrap_ranges(line, w).into_iter().map(|r| start + r.start..start + r.end));
        start += line.len() + 1;
    }
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

/// The agent box (`c`), centered: a bordered input, growing with its text.
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
    Block::bordered().border_type(BorderType::Rounded).border_style(fg(p.dim)).style(Style::new().bg(p.panel)).render(r, buf);
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

type Section = (&'static str, &'static [(&'static str, &'static str)]);

/// Two columns when the screen is wide enough, one otherwise.
const HELP: [&[Section]; 2] = [
    &[
        (
            "Move",
            &[
                ("j k", "tree: move · diff: scroll"),
                ("5j 3J 2}", "counts work on every move"),
                ("tab", "switch focus: tree ↔ diff"),
                ("J K  ] [", "next / prev file"),
                ("} {", "next / prev hunk"),
                ("d u", "half page down / up"),
                ("^d ^u", "tree: half page of rows · diff: as d u"),
                ("f b  space", "page down / up"),
                ("g G", "top / bottom"),
                ("12G", "tree: row 12 · diff: line 12 of this file"),
                ("^o", "back to where you were before a jump"),
                ("h l", "close / open folder · sideways when nowrap"),
                ("0", "back to the left edge (nowrap)"),
            ],
        ),
        (
            "View",
            &[
                ("s", "split / unified"),
                ("w", "wrap long lines"),
                ("e", "show / hide the file tree"),
                ("< >", "narrower / wider file tree"),
            ],
        ),
    ],
    &[
        (
            "Review",
            &[
                ("x", "mark viewed · on a folder: all its files"),
                ("z Z", "fold this file · fold / unfold all"),
                ("T", "show / hide test files"),
                ("t  ^p", "go to file"),
                ("/", "tree: filter files · diff: search the text"),
                ("n N", "next / prev search hit"),
                ("esc", "clear the filter / search"),
                ("^l", "in any input: clear what's typed"),
            ],
        ),
        (
            "Act",
            &[
                ("o", "open at this line in Zed ($EDITOR otherwise)"),
                ("E", "open the selected file in nvim in a new Herdr tab"),
                ("O", "open this line in the PR on GitHub"),
                ("y Y", "copy path · path:line"),
                ("drag", "select code · copied on release"),
                ("2x 3x click", "copy a word · a line"),
                ("c", "ask an agent in a new Herdr tab"),
                ("  ^i ^v ^j", "in it: file path · image · newline (⇧⏎ too)"),
                ("C", "commit & push all in a new Herdr tab"),
                (";", "this Herdr space's tabs, with a preview (al)"),
                ("  x ; c r ⏎", "in al: close · new agent · reply · go to it"),
                ("r", "reload the diff"),
                ("q", "quit"),
            ],
        ),
    ],
];

/// jp's keys, first in the help when the PR list is on.
const PR_HELP: Section = (
    "PRs (jp)",
    &[
        ("j k", "list: pick a PR, its diff on the right"),
        ("⏎ l", "list: the PR's files in the tree"),
        ("- ⌫ h", "files: back to the PR list"),
        ("( )", "prev / next PR from anywhere"),
        ("/", "list: filter (title, branch, #, merged…)"),
        ("x", "list: mark all of the PR's files viewed"),
        ("O", "list: open the PR on GitHub"),
        ("y Y", "list: copy the PR's URL · branch"),
        ("R", "search again: new PRs, checks, reviews"),
    ],
);

const KEY_W: u16 = 13;
const COL_W: u16 = 60;

fn help_height(sections: &[Section]) -> usize {
    sections.iter().map(|(_, ks)| ks.len() + 2).sum::<usize>() - 1
}

fn help(app: &App, buf: &mut Buffer, area: Rect) {
    let p = &app.pal;
    let mut first = HELP[0].to_vec();
    if app.prs.is_some() {
        first.insert(0, PR_HELP);
    }
    let both = [first, HELP[1].to_vec()];
    let two = area.width >= COL_W * 2 + 6;
    let (w, h) = if two {
        (COL_W * 2 + 2, both.iter().map(|c| help_height(c)).max().unwrap_or(0))
    } else {
        (COL_W + 2, help_height(&both.concat()))
    };
    let r = popup(area, w, h as u16 + 3);
    if r.width < 30 || r.height < 6 {
        return;
    }
    let inner = frame(buf, r, if app.prs.is_some() { "jp keys" } else { "jv keys" }, p);
    let cols: Vec<Vec<Section>> = if two { both.to_vec() } else { vec![both.concat()] };
    for (ci, col) in cols.iter().enumerate() {
        let x0 = inner.x + ci as u16 * COL_W;
        let right = (x0 + COL_W).min(inner.right());
        let mut y = inner.y + 1;
        for (title, keys) in col {
            if y >= inner.bottom() {
                break;
            }
            put(buf, x0 + 2, y, right, title, fg(p.muted).add_modifier(Modifier::BOLD));
            y += 1;
            for (k, d) in keys.iter() {
                if y >= inner.bottom() {
                    break;
                }
                put(buf, x0 + 3, y, right, k, fg(p.accent));
                put(buf, x0 + 3 + KEY_W, y, right, d, fg(p.fg));
                y += 1;
            }
            y += 1;
        }
    }
}
