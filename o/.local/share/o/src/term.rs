//! Drawing inline, as a shell's line editor does: no alternate screen, and
//! only what changed. The prompt's lines sit under whatever the terminal
//! showed; each frame is compared cell by cell with the last one, and only
//! the cells that differ are written, with the shortest cursor moves. Typing
//! a character at the end of a line writes that character and nothing else;
//! ⌫ there writes `\b\x1b[K`. Every byte goes through Rex's parser before
//! it's drawn, so fewer is faster.
//!
//! What's finished goes above the prompt, into the scrollback, for good.

use std::io::Write;

use ratatui::buffer::{Buffer, Cell};
use ratatui::crossterm::cursor;
use ratatui::style::{Color, Modifier};
use unicode_width::UnicodeWidthStr;

/// A cell's look: what the terminal writes with.
type Pen = (Color, Color, Modifier);

const DEFAULT_PEN: Pen = (Color::Reset, Color::Reset, Modifier::empty());

pub struct Inline {
    /// The screen row (0-based) of the prompt's first line.
    pub top: u16,
    /// The lines drawn from there last time; None when nothing of the
    /// prompt is on the screen (rows from `top` down are blank).
    prev: Option<Buffer>,
    /// The terminal's size.
    pub width: u16,
    pub rows: u16,
    /// Where the terminal's cursor is, on the screen.
    at: (u16, u16),
    /// What the terminal writes with now; None: not known.
    pen: Option<Pen>,
    shown: bool,
}

impl Inline {
    /// Start at `cursor` (the line after the command, as the terminal
    /// reported it) on a `width`×`rows` terminal.
    pub fn new(width: u16, rows: u16, cursor: (u16, u16)) -> Inline {
        // Not at a line's start (output that ended without a newline): the
        // next line, which the first frame makes room for.
        let top = cursor.1 + u16::from(cursor.0 > 0);
        Inline { top, prev: None, width, rows, at: cursor, pen: None, shown: true }
    }

    /// Bring the screen from the last frame to `buf`: scroll up first when
    /// it no longer fits under `top`, write the cells that changed, clear
    /// what's left of a taller frame, and put the cursor at `cursor` (from
    /// the first line), or hide it.
    pub fn draw(&mut self, s: &mut Vec<u8>, buf: &Buffer, cursor: Option<(u16, u16)>) {
        let start = s.len();
        let h = buf.area.height.min(self.rows);
        let old_h = self.prev.as_ref().map_or(0, |b| b.area.height);
        let mut big = false;
        if self.top + h > self.rows {
            // A line feed on the last row scrolls the screen up a line (a
            // blank one, in the pen's background: the default).
            let d = self.top + h - self.rows;
            self.go(s, self.at.0.min(self.width.saturating_sub(1)), self.rows - 1);
            self.pen_to(s, DEFAULT_PEN);
            s.extend(std::iter::repeat_n(b'\n', d as usize));
            self.top = self.top.saturating_sub(d);
            big = true;
        }
        let mut rows_changed = 0;
        for y in 0..h {
            let prev = self.prev.as_ref().filter(|p| y < p.area.height);
            let new_end = end(buf, y);
            let old_end = prev.map_or(0, |p| end(p, y));
            let first = (0..new_end.max(old_end)).find(|&x| !same(at(buf, x, y), prev.and_then(|p| at(p, x, y))));
            let Some(fx) = first else { continue };
            rows_changed += 1;
            // Start on a character, not inside a wide one.
            let fx = if fx < new_end { starts(buf, y, new_end).into_iter().take_while(|&x| x <= fx).last().unwrap_or(fx) } else { fx };
            self.go(s, fx, self.top + y);
            let x = self.cells(s, buf, y, fx, new_end);
            if old_end > x {
                self.pen_to(s, DEFAULT_PEN);
                s.extend_from_slice(b"\x1b[K");
            }
        }
        if old_h > h {
            self.go(s, 0, self.top + h);
            self.pen_to(s, DEFAULT_PEN);
            s.extend_from_slice(b"\x1b[J");
            rows_changed += 1;
        }
        self.prev = Some(buf.clone());
        match cursor.filter(|&(_, y)| y < h) {
            Some((x, y)) => {
                // A space typed at a line's end: written, rather than a move
                // over the blank cells (the same, in fewer bytes).
                let (cx, cy) = self.at;
                let blank_run = cy == self.top + y
                    && x > cx
                    && x - cx <= 3
                    && self.pen == Some(DEFAULT_PEN)
                    && (cx..x).all(|bx| at(buf, bx, y).is_none_or(|c| c.symbol() == " " && (c.fg, c.bg, c.modifier) == DEFAULT_PEN));
                if blank_run {
                    s.extend(std::iter::repeat_n(b' ', (x - cx) as usize));
                    self.at.0 = x;
                }
                self.go(s, x, self.top + y);
                if !self.shown {
                    s.extend_from_slice(b"\x1b[?25h");
                    self.shown = true;
                }
            }
            None if self.shown => {
                s.extend_from_slice(b"\x1b[?25l");
                self.shown = false;
            }
            None => {}
        }
        // More than a line's worth: let it land whole.
        if big || rows_changed > 1 {
            s.splice(start..start, b"\x1b[?2026h".iter().copied());
            s.extend_from_slice(b"\x1b[?2026l");
        }
    }

    /// Print `buf` where the prompt is, for good, and move the prompt under
    /// it (the next `draw` writes it again).
    pub fn print_above(&mut self, s: &mut Vec<u8>, buf: &Buffer) {
        self.go(s, 0, self.top);
        self.pen_to(s, DEFAULT_PEN);
        s.extend_from_slice(b"\x1b[J");
        for y in 0..buf.area.height {
            self.cells(s, buf, y, 0, end(buf, y));
            self.pen_to(s, DEFAULT_PEN);
            s.extend_from_slice(b"\r\n");
            // On the last row the line feed scrolled the screen instead.
            self.at = (0, (self.at.1 + 1).min(self.rows.saturating_sub(1)));
        }
        self.top = self.at.1;
        self.prev = None;
    }

    /// The terminal changed size: find the prompt again by the cursor, and
    /// clear from there. A narrower terminal (Ghostty, Herdr, Rex) rewraps the
    /// lines already drawn, so the cursor sits as many rows below `top` as
    /// the lines over it take now.
    pub fn resize(&mut self, s: &mut Vec<u8>, width: u16, rows: u16) {
        let widths: Vec<u16> = self.prev.as_ref().map_or_else(Vec::new, |p| (0..p.area.height).map(|y| end(p, y)).collect());
        let (cx, cy) = (self.at.0, self.at.1.saturating_sub(self.top));
        (self.width, self.rows) = (width, rows);
        let pos = cursor::position().unwrap_or(self.at);
        self.top = pos.1.saturating_sub(rows_above(&widths, cx, cy, width)).min(rows.saturating_sub(1));
        self.at = pos;
        self.go(s, 0, self.top);
        self.pen_to(s, DEFAULT_PEN);
        s.extend_from_slice(b"\x1b[J");
        self.prev = None;
    }

    /// ^l, as a shell's clear-screen: the screen blank, the prompt (drawn
    /// whole by the next `draw`) at its top.
    pub fn clear_screen(&mut self, s: &mut Vec<u8>) {
        s.extend_from_slice(b"\x1b[0m\x1b[H\x1b[2J");
        (self.top, self.at, self.pen, self.prev) = (0, (0, 0), Some(DEFAULT_PEN), None);
    }

    /// Quitting: the prompt's lines gone, the cursor where they started, for
    /// the shell's prompt.
    pub fn clear(&mut self, s: &mut Vec<u8>) {
        self.go(s, 0, self.top);
        s.extend_from_slice(b"\x1b[0m\x1b[J\x1b[?25h");
        self.prev = None;
    }

    /// The cursor to (x, y) on the screen, the short way.
    fn go(&mut self, s: &mut Vec<u8>, x: u16, y: u16) {
        let (cx, cy) = self.at;
        let _ = match (cx, cy) {
            _ if (cx, cy) == (x, y) => Ok(()),
            _ if cy == y && x == 0 => {
                s.push(b'\r');
                Ok(())
            }
            _ if cy == y && x + 1 == cx => {
                s.push(0x08);
                Ok(())
            }
            _ if cy == y && x < cx => write!(s, "\x1b[{}D", cx - x),
            _ if cy == y => write!(s, "\x1b[{}C", x - cx),
            _ if x == 0 && y == cy + 1 => {
                s.extend_from_slice(b"\r\n");
                Ok(())
            }
            _ => write!(s, "\x1b[{};{}H", y + 1, x + 1),
        };
        self.at = (x, y);
    }

    fn pen_to(&mut self, s: &mut Vec<u8>, p: Pen) {
        if self.pen != Some(p) {
            sgr(s, p);
            self.pen = Some(p);
        }
    }

    /// Write row `y`'s cells from `x` to `end`, from the cursor (on `x`).
    /// Returns the column it ends on.
    fn cells(&mut self, s: &mut Vec<u8>, buf: &Buffer, y: u16, mut x: u16, end: u16) -> u16 {
        while x < end {
            let c = &buf[(x, y)];
            self.pen_to(s, (c.fg, c.bg, c.modifier));
            let sym = c.symbol();
            s.extend_from_slice(sym.as_bytes());
            x += width(sym).max(1);
        }
        self.at.0 = x;
        x
    }
}

fn at(buf: &Buffer, x: u16, y: u16) -> Option<&Cell> {
    (x < buf.area.width && y < buf.area.height).then(|| &buf[(x, y)])
}

/// Two cells look the same (a missing one is blank).
fn same(a: Option<&Cell>, b: Option<&Cell>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.symbol() == b.symbol() && a.fg == b.fg && a.bg == b.bg && a.modifier == b.modifier,
        (Some(c), None) | (None, Some(c)) => blank(c),
        (None, None) => true,
    }
}

fn blank(c: &Cell) -> bool {
    c.symbol() == " " && c.bg == Color::Reset && !c.modifier.intersects(Modifier::REVERSED | Modifier::UNDERLINED)
}

/// The columns row `y` takes: up to its last cell that isn't blank.
fn end(buf: &Buffer, y: u16) -> u16 {
    (0..buf.area.width).rev().find(|&x| !blank(&buf[(x, y)])).map_or(0, |x| x + 1)
}

/// A symbol's columns.
fn width(sym: &str) -> u16 {
    sym.width() as u16
}

/// Where row `y`'s characters start, up to `end`.
fn starts(buf: &Buffer, y: u16, end: u16) -> Vec<u16> {
    let mut out = Vec::new();
    let mut x = 0;
    while x < end {
        out.push(x);
        x += width(buf[(x, y)].symbol()).max(1);
    }
    out
}

/// Row `y` of `buf` as plain text (--snapshot), an image's cells `▒`.
pub fn plain(buf: &Buffer, y: u16) -> String {
    let s: String = (0..buf.area.width).map(|x| buf[(x, y)].symbol()).map(|c| if crate::gfx::is_placeholder(c) { "▒" } else { c }).collect();
    s.trim_end().to_string()
}

/// The screen rows between the first line drawn and the cursor at
/// (`cur_x`, `cur_y`), once lines `widths` wide are rewrapped to `width`.
fn rows_above(widths: &[u16], cur_x: u16, cur_y: u16, width: u16) -> u16 {
    let width = width.max(1);
    let over: u16 = widths.iter().take(cur_y as usize).map(|&w| w.div_ceil(width).max(1)).sum();
    over + cur_x / width
}

fn sgr(s: &mut Vec<u8>, (fg, bg, m): Pen) {
    s.extend_from_slice(b"\x1b[0");
    for (bit, code) in [
        (Modifier::BOLD, ";1"),
        (Modifier::DIM, ";2"),
        (Modifier::ITALIC, ";3"),
        (Modifier::UNDERLINED, ";4"),
        (Modifier::REVERSED, ";7"),
        (Modifier::CROSSED_OUT, ";9"),
    ] {
        if m.contains(bit) {
            s.extend_from_slice(code.as_bytes());
        }
    }
    color(s, fg, 38);
    color(s, bg, 48);
    s.push(b'm');
}

fn color(s: &mut Vec<u8>, c: Color, base: u8) {
    let named = |n: u8| if n < 8 { (base - 8 + n) as u16 } else { (base + 52 + n - 8) as u16 };
    let _ = match c {
        Color::Reset => Ok(()),
        Color::Rgb(r, g, b) => write!(s, ";{base};2;{r};{g};{b}"),
        Color::Indexed(i) => write!(s, ";{base};5;{i}"),
        Color::Black => write!(s, ";{}", named(0)),
        Color::Red => write!(s, ";{}", named(1)),
        Color::Green => write!(s, ";{}", named(2)),
        Color::Yellow => write!(s, ";{}", named(3)),
        Color::Blue => write!(s, ";{}", named(4)),
        Color::Magenta => write!(s, ";{}", named(5)),
        Color::Cyan => write!(s, ";{}", named(6)),
        Color::Gray => write!(s, ";{}", named(7)),
        Color::DarkGray => write!(s, ";{}", named(8)),
        Color::LightRed => write!(s, ";{}", named(9)),
        Color::LightGreen => write!(s, ";{}", named(10)),
        Color::LightYellow => write!(s, ";{}", named(11)),
        Color::LightBlue => write!(s, ";{}", named(12)),
        Color::LightMagenta => write!(s, ";{}", named(13)),
        Color::LightCyan => write!(s, ";{}", named(14)),
        Color::White => write!(s, ";{}", named(15)),
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::layout::Rect;
    use ratatui::style::Style;

    /// A prompt line: `> ` then `text`, 20 wide.
    fn line(text: &str) -> Buffer {
        let mut b = Buffer::empty(Rect::new(0, 0, 20, 1));
        b.set_string(0, 0, "> ", Style::new());
        b.set_string(2, 0, text, Style::new());
        b
    }

    /// A terminal whose prompt is at row 5 of 24, drawn once with `first`.
    fn drawn(first: &Buffer, cursor: u16) -> Inline {
        let mut t = Inline::new(21, 24, (0, 5));
        let mut s = Vec::new();
        t.draw(&mut s, first, Some((cursor, 0)));
        t
    }

    fn frame(t: &mut Inline, b: &Buffer, cursor: u16) -> String {
        let mut s = Vec::new();
        t.draw(&mut s, b, Some((cursor, 0)));
        String::from_utf8(s).unwrap()
    }

    #[test]
    fn typing_at_the_end_writes_just_the_character() {
        let mut t = drawn(&line("hell"), 6);
        assert_eq!(frame(&mut t, &line("hello"), 7), "o");
        assert_eq!(frame(&mut t, &line("hello "), 8), " ");
        // Nothing changed: nothing written.
        assert_eq!(frame(&mut t, &line("hello "), 8), "");
    }

    #[test]
    fn backspace_at_the_end_moves_back_and_clears() {
        let mut t = drawn(&line("hello"), 7);
        assert_eq!(frame(&mut t, &line("hell"), 6), "\x08\x1b[K");
    }

    #[test]
    fn typing_mid_line_rewrites_the_rest_and_puts_the_cursor_back() {
        let mut t = drawn(&line("helo"), 5);
        assert_eq!(frame(&mut t, &line("hello"), 6), "lo\x08");
    }

    #[test]
    fn the_first_frame_writes_from_the_line_start() {
        let mut t = Inline::new(21, 24, (0, 5));
        let mut s = Vec::new();
        t.draw(&mut s, &line(""), Some((2, 0)));
        assert_eq!(String::from_utf8(s).unwrap(), "\x1b[0m> ");
    }

    #[test]
    fn a_new_line_under_the_last_row_scrolls_the_screen() {
        let mut t = Inline::new(21, 6, (0, 5));
        let mut s = Vec::new();
        let mut two = Buffer::empty(Rect::new(0, 0, 20, 2));
        two.set_string(0, 0, "> a", Style::new());
        two.set_string(2, 1, "b", Style::new());
        t.draw(&mut s, &line("a"), Some((3, 0)));
        s.clear();
        t.draw(&mut s, &two, Some((3, 1)));
        assert_eq!(t.top, 4);
        assert!(String::from_utf8(s).unwrap().contains('\n'));
    }

    #[test]
    fn ctrl_l_clears_and_draws_the_prompt_at_the_top() {
        let mut t = drawn(&line("hi"), 4);
        let mut s = Vec::new();
        t.clear_screen(&mut s);
        t.draw(&mut s, &line("hi"), Some((4, 0)));
        assert_eq!(String::from_utf8(s).unwrap(), "\x1b[0m\x1b[H\x1b[2J> hi");
        assert_eq!(t.top, 0);
    }

    #[test]
    fn counts_the_rows_a_narrower_terminal_rewraps_to() {
        assert_eq!(rows_above(&[96, 90, 96], 60, 1, 120), 1);
        assert_eq!(rows_above(&[96, 90, 96], 60, 1, 70), 2);
        assert_eq!(rows_above(&[96, 90, 96], 75, 1, 70), 3);
        assert_eq!(rows_above(&[0, 0], 0, 2, 70), 2);
    }

    #[test]
    fn names_colors() {
        let mut s = Vec::new();
        sgr(&mut s, (Color::Red, Color::DarkGray, Modifier::BOLD));
        assert_eq!(String::from_utf8(s).unwrap(), "\x1b[0;1;31;100m");
    }
}
