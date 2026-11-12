//! Drawing text into a ratatui buffer: clipped, truncated with an ellipsis.

use ratatui::buffer::Buffer;
use ratatui::style::{Color, Style};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// Write `s` at x,y, never past `max_x`. Where the text ended.
pub fn put(buf: &mut Buffer, x: u16, y: u16, max_x: u16, s: &str, st: Style) -> u16 {
    if x >= max_x || s.is_empty() {
        return x;
    }
    buf.set_stringn(x, y, s, (max_x - x) as usize, st).0
}

pub fn fg(c: Color) -> Style {
    Style::new().fg(c)
}

/// At most `w` cells, ending in `…` when cut.
pub fn truncate(s: &str, w: usize) -> String {
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
pub fn truncate_left(s: &str, w: usize) -> String {
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

/// `now`, `12m`, `3h`, `5d`, `2w`, `4mo` from a unix-ms time.
pub fn age_label(then_ms: f64, now_ms: f64) -> String {
    if then_ms <= 0.0 {
        return String::new();
    }
    let s = ((now_ms - then_ms) / 1000.0).max(0.0) as u64;
    match s {
        0..=59 => "now".to_string(),
        60..=3599 => format!("{}m", s / 60),
        3600..=86_399 => format!("{}h", s / 3600),
        86_400..=604_799 => format!("{}d", s / 86_400),
        604_800..=5_183_999 => format!("{}w", s / 604_800),
        _ => format!("{}mo", s / 2_592_000),
    }
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}
