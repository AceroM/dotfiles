//! What o asks the terminal at startup, in one round trip: whether it
//! speaks the kitty keyboard protocol (so shift+Enter and ^⏎ arrive as
//! themselves), where the cursor is (the prompt starts there), and whether
//! it draws Kitty images, with a cell's size in pixels (the drafts list's
//! pictures, gfx.rs). The primary device attributes go last: every terminal
//! answers them, so they end the wait.

use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::time::{Duration, Instant};

use crate::gfx::{self, Gfx};

pub struct Probe {
    pub kitty_keys: bool,
    /// The cursor, (column, row), 0-based.
    pub cursor: Option<(u16, u16)>,
    /// Kitty images, and the cell they're measured in; None where the
    /// terminal doesn't draw them (or O_IMAGES=0).
    pub gfx: Option<Gfx>,
}

/// Ask. Call it in raw mode, before anything else reads input: the answers
/// come back on stdin.
pub fn probe() -> Probe {
    let none = Probe { kitty_keys: false, cursor: None, gfx: None };
    let fd = io::stdin().as_raw_fd();
    if unsafe { libc::isatty(fd) } != 1 {
        return none;
    }
    let mut ask = b"\x1b[?u\x1b[6n".to_vec();
    let images = gfx::wanted();
    if images {
        ask.extend_from_slice(gfx::QUERY);
        ask.extend_from_slice(b"\x1b[16t");
    }
    ask.extend_from_slice(b"\x1b[c");
    let mut out = io::stdout();
    if out.write_all(&ask).and_then(|()| out.flush()).is_err() {
        return none;
    }
    let reply = read_replies(fd, Duration::from_millis(500));
    let gfx = (images && gfx::supported(&reply)).then(|| gfx::cell_from_reply(&reply).or_else(gfx::cell_from_ioctl)).flatten();
    Probe { kitty_keys: csi_reply(&reply, "\x1b[?", 'u').is_some(), cursor: cursor_from_reply(&reply), gfx }
}

fn read_replies(fd: i32, timeout: Duration) -> String {
    let deadline = Instant::now() + timeout;
    let mut got: Vec<u8> = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        let mut p = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        let ms = left.as_millis().clamp(1, i32::MAX as u128) as i32;
        if unsafe { libc::poll(&mut p, 1, ms) } <= 0 {
            break;
        }
        let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
        if n <= 0 {
            break;
        }
        got.extend_from_slice(&buf[..n as usize]);
        if csi_reply(&String::from_utf8_lossy(&got), "\x1b[?", 'c').is_some() {
            break;
        }
    }
    String::from_utf8_lossy(&got).into_owned()
}

/// The body of the first `start … end` reply (digits and `;` between).
fn csi_reply<'a>(s: &'a str, start: &str, end: char) -> Option<&'a str> {
    let mut rest = s;
    while let Some(i) = rest.find(start) {
        let body = &rest[i + start.len()..];
        let n = body.find(|c: char| !(c.is_ascii_digit() || c == ';')).unwrap_or(body.len());
        if body[n..].starts_with(end) {
            return Some(&body[..n]);
        }
        rest = body;
    }
    None
}

/// `ESC [ row ; col R`, 1-based, as (column, row) 0-based.
fn cursor_from_reply(s: &str) -> Option<(u16, u16)> {
    let (r, c) = csi_reply(s, "\x1b[", 'R')?.split_once(';')?;
    Some((c.parse::<u16>().ok()?.saturating_sub(1), r.parse::<u16>().ok()?.saturating_sub(1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_replies() {
        let r = "\x1b[?1u\x1b[12;1R\x1b[?62;22c";
        assert_eq!(csi_reply(r, "\x1b[?", 'u'), Some("1"));
        assert_eq!(csi_reply(r, "\x1b[?", 'c'), Some("62;22"));
        assert_eq!(cursor_from_reply(r), Some((0, 11)));
        // No keyboard protocol: only the cursor and the device attributes.
        let r = "\x1b[3;5R\x1b[?62;22c";
        assert_eq!(csi_reply(r, "\x1b[?", 'u'), None);
        assert_eq!(cursor_from_reply(r), Some((4, 2)));
        // Cut short: no device attributes yet.
        assert_eq!(csi_reply("\x1b[?62;2", "\x1b[?", 'c'), None);
    }
}
