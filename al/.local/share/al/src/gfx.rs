//! A draft's images in the preview, with the Kitty graphics protocol's unicode
//! placeholders (ctab's gfx.rs, which draws its screenshots the same way). The
//! PNG goes to the terminal once (`a=T,U=1`), then ordinary cells draw it:
//! U+10EEEE with the cell's row and column in two diacritics and the image id
//! in the foreground color. Since the picture lives in text cells, ratatui's
//! redraws, scrolling and the boxes over it need nothing special.
//!
//! Ghostty and kitty speak it, and Herdr (0.9 on) passes it through. Anywhere
//! the terminal doesn't answer the query, a draft lists its image files
//! instead. AL_IMAGES=0 turns it off.

use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::time::{Duration, Instant};

use ratatui::buffer::Cell;
use ratatui::buffer::CellDiffOption;
use ratatui::style::Color;

/// The terminal's cell, in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Gfx {
    pub cell_w: u16,
    pub cell_h: u16,
}

/// The character Kitty reserves for image placeholders.
const PLACEHOLDER: char = '\u{10EEEE}';

/// Ask the terminal whether it draws Kitty images, and how big a cell is.
/// Call it in raw mode, before anything reads input.
pub fn detect() -> Option<Gfx> {
    if std::env::var("AL_IMAGES").is_ok_and(|v| matches!(v.as_str(), "0" | "off" | "no" | "false")) {
        return None;
    }
    let stdin = io::stdin();
    let fd = stdin.as_raw_fd();
    if unsafe { libc::isatty(fd) } != 1 {
        return None;
    }
    // A Kitty query, the cell size in pixels, then the primary device
    // attributes: every terminal answers that last one, so it ends the wait.
    let mut out = io::stdout();
    out.write_all(b"\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[16t\x1b[c").ok()?;
    out.flush().ok()?;
    let reply = read_replies(fd, Duration::from_millis(500));
    if !reply.contains("\x1b_Gi=31;OK") {
        return None;
    }
    let (cell_w, cell_h) = cell_from_reply(&reply).or_else(cell_from_ioctl)?;
    Some(Gfx { cell_w, cell_h })
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
        if has_device_attributes(&got) {
            break;
        }
    }
    String::from_utf8_lossy(&got).into_owned()
}

/// `ESC [ ? 62 ; 22 c`
fn has_device_attributes(b: &[u8]) -> bool {
    b.windows(3).enumerate().any(|(i, w)| {
        w == b"\x1b[?" && {
            let rest = &b[i + 3..];
            let end = rest.iter().position(|c| !(c.is_ascii_digit() || *c == b';'));
            end.is_some_and(|e| rest[e] == b'c')
        }
    })
}

/// `ESC [ 6 ; height ; width t`
fn cell_from_reply(s: &str) -> Option<(u16, u16)> {
    let rest = &s[s.find("\x1b[6;")? + 4..];
    let body = &rest[..rest.find('t')?];
    let (h, w) = body.split_once(';')?;
    let (w, h): (u16, u16) = (w.parse().ok()?, h.parse().ok()?);
    (w > 0 && h > 0).then_some((w, h))
}

fn cell_from_ioctl() -> Option<(u16, u16)> {
    let s = ratatui::crossterm::terminal::window_size().ok()?;
    (s.columns > 0 && s.rows > 0 && s.width > 0 && s.height > 0).then(|| (s.width / s.columns, s.height / s.rows))
}

// ---- PNGs --------------------------------------------------------------------

/// A PNG's width and height, from its IHDR chunk.
pub fn png_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 24 || &b[..8] != b"\x89PNG\r\n\x1a\n" || &b[12..16] != b"IHDR" {
        return None;
    }
    let be = |i: usize| u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    Some((be(16), be(20)))
}

/// Standard base64, padded: what the protocol wants for `t=d` data.
pub fn base64(b: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            out.push(if i <= c.len() { A[(n >> shift & 63) as usize] as char } else { '=' });
        }
    }
    out
}

// ---- writing images ----------------------------------------------------------

/// The ids al hands out: under 2^24, so the id fits the foreground color
/// alone, and apart from ctab's (0xC7Axxx).
pub fn image_id(n: u32) -> u32 {
    0x00A1_0000 + n % 0x1000
}

/// Send a PNG (base64) and make it a `cols`×`rows` virtual placement, replacing
/// any image with the same id. q=2: the terminal answers nothing.
pub fn transmit(id: u32, png_b64: &str, cols: u16, rows: u16) -> Vec<u8> {
    let data = png_b64.as_bytes();
    let mut out = Vec::with_capacity(data.len() + data.len() / 4096 * 16 + 64);
    let chunks: Vec<&[u8]> = data.chunks(4096).collect();
    for (i, c) in chunks.iter().enumerate() {
        let more = u8::from(i + 1 < chunks.len());
        if i == 0 {
            let _ = write!(out, "\x1b_Ga=T,U=1,f=100,t=d,i={id},c={cols},r={rows},q=2,m={more};");
        } else {
            let _ = write!(out, "\x1b_Gm={more};");
        }
        out.extend_from_slice(c);
        out.extend_from_slice(b"\x1b\\");
    }
    out
}

/// Free an image and its placements.
pub fn delete(id: u32) -> Vec<u8> {
    format!("\x1b_Ga=d,d=I,i={id},q=2;\x1b\\").into_bytes()
}

/// The largest row or column a placeholder can name.
pub const MAX_CELLS: u16 = DIACRITICS.len() as u16;

/// Turn `cell` into the placeholder for (`row`, `col`) of image `id`.
pub fn placeholder(cell: &mut Cell, id: u32, row: u16, col: u16) {
    let mut s = String::with_capacity(12);
    s.push(PLACEHOLDER);
    s.push(diacritic(row));
    s.push(diacritic(col));
    cell.set_symbol(&s)
        .set_fg(Color::Rgb((id >> 16) as u8, (id >> 8) as u8, id as u8))
        .set_diff_option(CellDiffOption::ForcedWidth(std::num::NonZeroU16::MIN));
}

fn diacritic(n: u16) -> char {
    char::from_u32(DIACRITICS[usize::from(n).min(DIACRITICS.len() - 1)]).unwrap_or('\u{305}')
}

/// Kitty's rowcolumn-diacritics.txt: the n-th mark means row (or column) n.
/// https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders
const DIACRITICS: [u32; 297] = [
    0x305, 0x30D, 0x30E, 0x310, 0x312, 0x33D, 0x33E, 0x33F, 0x346, 0x34A, 0x34B, 0x34C,
    0x350, 0x351, 0x352, 0x357, 0x35B, 0x363, 0x364, 0x365, 0x366, 0x367, 0x368, 0x369,
    0x36A, 0x36B, 0x36C, 0x36D, 0x36E, 0x36F, 0x483, 0x484, 0x485, 0x486, 0x487, 0x592,
    0x593, 0x594, 0x595, 0x597, 0x598, 0x599, 0x59C, 0x59D, 0x59E, 0x59F, 0x5A0, 0x5A1,
    0x5A8, 0x5A9, 0x5AB, 0x5AC, 0x5AF, 0x5C4, 0x610, 0x611, 0x612, 0x613, 0x614, 0x615,
    0x616, 0x617, 0x657, 0x658, 0x659, 0x65A, 0x65B, 0x65D, 0x65E, 0x6D6, 0x6D7, 0x6D8,
    0x6D9, 0x6DA, 0x6DB, 0x6DC, 0x6DF, 0x6E0, 0x6E1, 0x6E2, 0x6E4, 0x6E7, 0x6E8, 0x6EB,
    0x6EC, 0x730, 0x732, 0x733, 0x735, 0x736, 0x73A, 0x73D, 0x73F, 0x740, 0x741, 0x743,
    0x745, 0x747, 0x749, 0x74A, 0x7EB, 0x7EC, 0x7ED, 0x7EE, 0x7EF, 0x7F0, 0x7F1, 0x7F3,
    0x816, 0x817, 0x818, 0x819, 0x81B, 0x81C, 0x81D, 0x81E, 0x81F, 0x820, 0x821, 0x822,
    0x823, 0x825, 0x826, 0x827, 0x829, 0x82A, 0x82B, 0x82C, 0x82D, 0x951, 0x953, 0x954,
    0xF82, 0xF83, 0xF86, 0xF87, 0x135D, 0x135E, 0x135F, 0x17DD, 0x193A, 0x1A17, 0x1A75, 0x1A76,
    0x1A77, 0x1A78, 0x1A79, 0x1A7A, 0x1A7B, 0x1A7C, 0x1B6B, 0x1B6D, 0x1B6E, 0x1B6F, 0x1B70, 0x1B71,
    0x1B72, 0x1B73, 0x1CD0, 0x1CD1, 0x1CD2, 0x1CDA, 0x1CDB, 0x1CE0, 0x1DC0, 0x1DC1, 0x1DC3, 0x1DC4,
    0x1DC5, 0x1DC6, 0x1DC7, 0x1DC8, 0x1DC9, 0x1DCB, 0x1DCC, 0x1DD1, 0x1DD2, 0x1DD3, 0x1DD4, 0x1DD5,
    0x1DD6, 0x1DD7, 0x1DD8, 0x1DD9, 0x1DDA, 0x1DDB, 0x1DDC, 0x1DDD, 0x1DDE, 0x1DDF, 0x1DE0, 0x1DE1,
    0x1DE2, 0x1DE3, 0x1DE4, 0x1DE5, 0x1DE6, 0x1DFE, 0x20D0, 0x20D1, 0x20D4, 0x20D5, 0x20D6, 0x20D7,
    0x20DB, 0x20DC, 0x20E1, 0x20E7, 0x20E9, 0x20F0, 0x2CEF, 0x2CF0, 0x2CF1, 0x2DE0, 0x2DE1, 0x2DE2,
    0x2DE3, 0x2DE4, 0x2DE5, 0x2DE6, 0x2DE7, 0x2DE8, 0x2DE9, 0x2DEA, 0x2DEB, 0x2DEC, 0x2DED, 0x2DEE,
    0x2DEF, 0x2DF0, 0x2DF1, 0x2DF2, 0x2DF3, 0x2DF4, 0x2DF5, 0x2DF6, 0x2DF7, 0x2DF8, 0x2DF9, 0x2DFA,
    0x2DFB, 0x2DFC, 0x2DFD, 0x2DFE, 0x2DFF, 0xA66F, 0xA67C, 0xA67D, 0xA6F0, 0xA6F1, 0xA8E0, 0xA8E1,
    0xA8E2, 0xA8E3, 0xA8E4, 0xA8E5, 0xA8E6, 0xA8E7, 0xA8E8, 0xA8E9, 0xA8EA, 0xA8EB, 0xA8EC, 0xA8ED,
    0xA8EE, 0xA8EF, 0xA8F0, 0xA8F1, 0xAAB0, 0xAAB2, 0xAAB3, 0xAAB7, 0xAAB8, 0xAABE, 0xAABF, 0xAAC1,
    0xFE20, 0xFE21, 0xFE22, 0xFE23, 0xFE24, 0xFE25, 0xFE26, 0x10A0F, 0x10A38, 0x1D185, 0x1D186, 0x1D187,
    0x1D188, 0x1D189, 0x1D1AA, 0x1D1AB, 0x1D1AC, 0x1D1AD, 0x1D242, 0x1D243, 0x1D244,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_replies() {
        let r = "\x1b_Gi=31;OK\x1b\\\x1b[6;37;17t\x1b[4;925;3077t\x1b[?62;22c";
        assert_eq!(cell_from_reply(r), Some((17, 37)));
        assert!(has_device_attributes(r.as_bytes()));
        assert!(!has_device_attributes(b"\x1b_Gi=31;OK\x1b\\\x1b[?62;2"));
    }

    #[test]
    fn encodes_base64() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0x00, 0x01]), "//4AAQ==");
    }

    #[test]
    fn reads_png_size() {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        b.extend_from_slice(&1440u32.to_be_bytes());
        b.extend_from_slice(&900u32.to_be_bytes());
        assert_eq!(png_size(&b), Some((1440, 900)));
        assert_eq!(png_size(b"GIF89a.................."), None);
    }

    #[test]
    fn chunks_the_png() {
        let png = "A".repeat(9000);
        let s = String::from_utf8(transmit(image_id(1), &png, 40, 12)).unwrap();
        assert!(s.starts_with("\x1b_Ga=T,U=1,f=100,t=d,i=10551297,c=40,r=12,q=2,m=1;"));
        assert_eq!(s.matches("\x1b_G").count(), 3);
        assert!(s.contains("\x1b_Gm=1;") && s.contains("\x1b_Gm=0;"));
        assert_eq!(s.matches('A').count(), 9000);
    }

    #[test]
    fn placeholders_carry_position_and_id() {
        let mut c = Cell::default();
        placeholder(&mut c, 0x00A1_0001, 2, 5);
        let chars: Vec<char> = c.symbol().chars().collect();
        assert_eq!(chars, ['\u{10EEEE}', '\u{30E}', '\u{33D}']);
        assert_eq!(c.fg, Color::Rgb(0xA1, 0x00, 0x01));
    }
}
