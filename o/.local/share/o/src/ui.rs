//! What o draws: the configuration ⏎ starts and `>` (`claude(opus) >`,
//! yellow in plan mode), then the text in the terminal's own color,
//! `[Image #N]` tags in blue; under it a
//! toast and what's starting, only when there are. The drafts list (^g)
//! draws the selected draft's images over it, as Kitty placeholders
//! (gfx.rs). Nothing else, so a key
//! changes as few cells as it can (term.rs writes only those). Each send,
//! once started, is printed above in the scrollback: the prompt as it went,
//! and the tab it went to.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::app::{App, Sent};
use crate::field;
use crate::gfx;

/// A sent prompt's echo shows at most this many rows.
const ECHO_ROWS: usize = 4;

// ---- helpers -------------------------------------------------------------

fn put(buf: &mut Buffer, x: u16, y: u16, max_x: u16, s: &str, st: Style) -> u16 {
    if x >= max_x || s.is_empty() || y >= buf.area.bottom() {
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

/// Row `r` of `text` at (x, y) in `st`, its `[Image #N]` tags in `tag`.
/// Returns the column after it.
#[allow(clippy::too_many_arguments)]
fn text_row(buf: &mut Buffer, x: u16, y: u16, max: u16, text: &str, r: std::ops::Range<usize>, st: Style, tag: Color) -> u16 {
    let tags = field::image_tags(text);
    let end = put(buf, x, y, max, &text[r.clone()], st);
    let mut cx = x;
    for (bi, c) in text[r.clone()].char_indices() {
        let cw = c.width().unwrap_or(0) as u16;
        if cx + cw > max {
            break;
        }
        if tags.iter().any(|(t, _)| t.contains(&(r.start + bi))) {
            buf[(cx, y)].set_fg(tag);
        }
        cx += cw;
    }
    end
}

// ---- the prompt ------------------------------------------------------------

/// The prompt's lines, `app.lay.height` of them, one column short of the
/// terminal's width (term.rs leaves the last alone).
pub fn draw(app: &App) -> Buffer {
    let w = app.lay.width.saturating_sub(1).max(1);
    let mut buf = Buffer::empty(Rect::new(0, 0, w, app.lay.height));
    if let Some(sel) = app.sent_at {
        sent_selection(app, &mut buf, sel);
    } else {
        match app.list {
            Some(sel) => list(app, &mut buf, sel),
            None => lines(app, &mut buf),
        }
    }
    let mut y = app.lay.text.bottom();
    if toast(app, &mut buf, y) {
        y += 1;
    }
    starting(app, &mut buf, y);
    buf
}

fn sent_selection(app: &App, buf: &mut Buffer, sel: usize) {
    let s = &app.sent[sel];
    let max = buf.area.width;
    let p = &app.pal;
    put(buf, 0, 0, max, "▸", fg(p.accent));
    let title = format!("{} · {}", s.name, field::first_line(&s.text));
    put(buf, 2, 0, max, &truncate(&title, max.saturating_sub(2) as usize), Style::new());
    if app.lay.text.height > 1 {
        let (destination, color) = match &s.outcome {
            Some((message, ok, _)) => (message.as_str(), if *ok { p.accent } else { p.red }),
            None => ("starting…", p.yellow),
        };
        put(buf, 2, 1, max, destination, fg(color));
    }
    if app.lay.text.height > 2 {
        let keys = format!("{}/{} · ↑ ↓ sessions · ⏎ focus · esc compose", sel + 1, app.sent.len());
        put(buf, 2, 2, max, &keys, fg(p.dim));
    }
}

fn lines(app: &App, buf: &mut Buffer) {
    let p = &app.pal;
    let t = app.lay.text;
    let max = buf.area.width;
    let f = &app.field;
    let text = &f.text;
    let sel = f.selection();
    for (r, row) in app.rows.iter().enumerate().skip(app.scroll).take(t.height as usize) {
        let y = t.y + (r - app.scroll) as u16;
        if r == 0 {
            // `claude(opus) >`; a draft's glyph is al's ◇.
            put(buf, 0, y, max, &app.prefix(), fg(if app.plan { p.yellow } else { p.muted }));
        }
        let x_end = text_row(buf, t.x, y, max, text, row.clone(), Style::new(), p.accent);
        // The selection lit; a selected line break shows as a cell past the
        // row's text.
        let Some(s) = sel.as_ref() else { continue };
        let mut x = t.x;
        for (bi, c) in text[row.clone()].char_indices() {
            let cw = (c.width().unwrap_or(0) as u16).max(1);
            if x + cw > max {
                break;
            }
            if s.contains(&(row.start + bi)) {
                for cx in x..x + cw {
                    buf[(cx, y)].set_bg(p.sel);
                }
            }
            x += cw;
        }
        let breaks = text.as_bytes().get(row.end) == Some(&b'\n');
        if breaks && s.contains(&row.end) && x_end < max {
            buf[(x_end, y)].set_bg(p.sel);
        }
    }
}

/// The drafts list (^g), in the prompt's place: the selected draft's
/// images on top, then a draft a row (`▸` the selected one, `◆` a marked
/// one, a reply's agent before its first line, its folder at the right),
/// the selected one's text under them, then the keys.
fn list(app: &App, buf: &mut Buffer, sel: usize) {
    let p = &app.pal;
    let max = buf.area.width;
    let v = &app.view;
    let mut y = 0;
    if v.strip > 0 {
        strip(app, buf);
        y = v.strip as u16;
    }
    for (i, d) in app.drafts.iter().enumerate().skip(v.top).take(v.shown) {
        let on = i == sel;
        let marked = app.marked.contains(&d.id);
        if on {
            put(buf, 0, y, max, "▸", fg(p.accent));
        }
        // Its folder (and its configuration, when it isn't the first), at
        // the right, when there's room.
        let folder = d.cwd.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let side = match app.draft_agent(d) {
            Some(name) if d.reply.is_none() && name != app.agents[0].name => format!("{name} · {folder}"),
            _ => folder,
        };
        let side_w = side.width() as u16;
        let text_max = if max > side_w + 24 { max - side_w - 2 } else { max };
        let glyph = if marked { "◆ " } else { "◇ " };
        let mut x = put(buf, 2, y, text_max, glyph, fg(if d.plan { p.yellow } else if marked { p.accent } else { p.dim }));
        if let Some(r) = &d.reply {
            x = put(buf, x, y, text_max, &format!("↳{} ", r.label), fg(p.accent));
        }
        let first = field::first_line(&d.text);
        let room = text_max.saturating_sub(x) as usize;
        if first.is_empty() {
            put(buf, x, y, text_max, "(empty)", fg(p.dim));
        } else {
            put(buf, x, y, text_max, &truncate(&first, room), if on || marked { Style::new() } else { fg(p.muted) });
        }
        if text_max < max {
            put(buf, max - side_w, y, max, &side, fg(p.dim));
        }
        if marked {
            for cx in 2..max {
                buf[(cx, y)].set_bg(p.sel);
            }
        }
        y += 1;
    }
    let text = app.drafts.get(sel).map_or("", |d| d.text.as_str());
    for r in v.rows.iter().take(v.preview) {
        put(buf, 2, y, max, "│", fg(p.dim));
        text_row(buf, 4, y, max, text, r.clone(), fg(p.muted), p.accent);
        y += 1;
    }
    if v.more > 0 && y + 1 < app.lay.text.bottom() {
        put(buf, 2, y, max, &format!("│ … +{} line{}", v.more, if v.more == 1 { "" } else { "s" }), fg(p.dim));
        y += 1;
    }
    let keys = match app.marked.len() {
        0 => format!("{}/{} · j k · ⇧↑↓ mark · ⏎ send · e edit · x delete · u undo · d new · esc back", sel + 1, app.drafts.len()),
        1 => "1 marked · ⇧↑↓ space a mark · ⏎ send it · x delete · esc unmark".to_string(),
        n => format!("{n} marked · ⇧↑↓ space a mark · ⏎ send as one prompt · x delete · esc unmark"),
    };
    put(buf, 2, y, max, &truncate(&keys, max.saturating_sub(2) as usize), fg(p.dim));
}

/// The selected draft's images, side by side over the list, each with its
/// `[Image #N]` under it; or what's said instead (no images, loading…).
fn strip(app: &App, buf: &mut Buffer) {
    let p = &app.pal;
    let max = buf.area.width;
    let v = &app.view;
    let mut end = 2;
    for t in &v.thumbs {
        let x0 = 2 + t.x;
        for r in 0..t.rows {
            for c in 0..t.cols {
                if let Some(cell) = buf.cell_mut((x0 + c, r)) {
                    gfx::placeholder(cell, t.id, r, c);
                }
            }
        }
        let label = put(buf, x0, t.rows, max, &format!("[Image #{}]", t.n), fg(p.accent));
        end = end.max(x0 + t.cols).max(label);
    }
    if let Some(note) = &v.note {
        let x = if v.thumbs.is_empty() { 2 } else { end + 2 };
        put(buf, x, 0, max, note, fg(p.dim));
    }
}

/// A toast, under the text for a moment: green when it worked, red when
/// it didn't. False when there's none.
fn toast(app: &App, buf: &mut Buffer, y: u16) -> bool {
    let Some((m, ok, _)) = &app.toast else { return false };
    let p = &app.pal;
    let max = buf.area.width;
    let x = put(buf, 2, y, max, if *ok { "✓ " } else { "✗ " }, fg(if *ok { p.green } else { p.red }));
    put(buf, x, y, max, &truncate(m, max.saturating_sub(x) as usize), fg(p.dim));
    true
}

/// The sends still starting, under the text.
fn starting(app: &App, buf: &mut Buffer, y0: u16) {
    let p = &app.pal;
    let max = buf.area.width;
    let rows = app.sent.iter().filter(|s| s.outcome.is_none());
    for (y, s) in (y0..buf.area.bottom()).zip(rows) {
        let mut x = put(buf, 2, y, max, "• ", fg(p.yellow));
        x = put(buf, x, y, max, &s.name, fg(p.accent));
        x = put(buf, x, y, max, " · ", fg(p.dim));
        let room = max.saturating_sub(x + 14) as usize;
        x = put(buf, x, y, max, &truncate(&field::first_line(&s.text), room), fg(p.muted));
        put(buf, x + 2, y, max, "starting…", fg(p.dim));
    }
}

// ---- the scrollback ----------------------------------------------------------

/// A started (or failed) send, for printing above the prompt: the prompt as
/// it went (its first rows), then where it went, then a blank line.
pub fn entry(app: &App, s: &Sent, width: u16) -> Buffer {
    let p = &app.pal;
    let w = width.saturating_sub(1).max(1);
    let tw = (w as usize).saturating_sub(3).max(4);
    let rows = field::word_rows(&s.text, tw);
    let shown = rows.len().min(ECHO_ROWS);
    let more = rows.len() - shown;
    let h = shown + usize::from(more > 0) + 2;
    let mut buf = Buffer::empty(Rect::new(0, 0, w, h as u16));
    for (i, r) in rows.iter().take(shown).enumerate() {
        if i == 0 {
            put(&mut buf, 0, 0, w, ">", fg(p.muted));
        }
        text_row(&mut buf, 2, i as u16, w, &s.text, r.clone(), fg(p.muted), p.accent);
    }
    let mut y = shown as u16;
    if more > 0 {
        put(&mut buf, 2, y, w, &format!("… +{more} line{}", if more == 1 { "" } else { "s" }), fg(p.dim));
        y += 1;
    }
    let x = put(&mut buf, 2, y, w, "⎿  ", fg(p.dim));
    match &s.outcome {
        Some((m, true, _)) => {
            let mut x = put(&mut buf, x, y, w, &s.name, fg(p.accent));
            if s.plan {
                x = put(&mut buf, x, y, w, " · plan", fg(p.yellow));
            }
            put(&mut buf, x + 1, y, w, m, fg(p.dim));
        }
        Some((m, false, _)) => {
            put(&mut buf, x, y, w, &format!("✗ {m}"), fg(p.red));
        }
        None => {}
    }
    buf
}
