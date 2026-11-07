//! Marking preview text and copying it, the way Codex does in its transcript:
//! drag to mark (shown in reverse video), double-click for a word, triple-click
//! for a line. Words follow Unicode's word boundaries, as Codex's do, so
//! `AGENTS.md` and `v0.1` are one word while `/` and `-` split. The mark stays
//! after the button comes up; ^c copies it, ⏎ copies and lets the preview
//! follow the pane again, esc or a click elsewhere clears it.

use std::io::Write;
use std::process::{Command, Stdio};

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthChar;

use crate::ansi::Line;

/// Past every line's end: a mark running to here takes the line break too.
pub const EOL: usize = usize::MAX;

/// A caret place in the preview's text: a line of what it shows, and the
/// cells from that line's start the caret sits after.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Spot {
    pub line: usize,
    pub col: usize,
}

/// Marked text: the cells between where the mark started and its other end.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Sel {
    pub anchor: Spot,
    pub head: Spot,
}

impl Sel {
    /// Line `i` whole, with its break (a triple-click).
    pub fn line(i: usize) -> Sel {
        Sel { anchor: Spot { line: i, col: 0 }, head: Spot { line: i, col: EOL } }
    }

    fn ends(&self) -> (Spot, Spot) {
        if self.anchor <= self.head {
            (self.anchor, self.head)
        } else {
            (self.head, self.anchor)
        }
    }

    /// Line `i`'s marked cells as `a..b`; `b` is EOL when the mark runs on
    /// past the line's end.
    pub fn cols(&self, i: usize) -> Option<(usize, usize)> {
        let (s, e) = self.ends();
        if i < s.line || i > e.line {
            return None;
        }
        let a = if i == s.line { s.col } else { 0 };
        let b = if i == e.line { e.col } else { EOL };
        (a < b).then_some((a, b))
    }

    /// Lines moved down by `n` (earlier lines loaded in above them).
    pub fn shifted(self, n: usize) -> Sel {
        let sh = |s: Spot| Spot { line: s.line + n, ..s };
        Sel { anchor: sh(self.anchor), head: sh(self.head) }
    }
}

/// How a line carries on from the one above it when both are one paragraph
/// wrapped (the transcript's): copying joins them back up, dropping the
/// line's indent and putting back the space the wrap took, if it took one.
#[derive(Clone, Copy, Debug)]
pub struct Wrap {
    pub indent: usize,
    pub space: bool,
}

/// A line's text, its styles dropped.
pub fn plain(line: &Line) -> String {
    line.iter().map(|(s, _)| s.as_str()).collect()
}

/// Each character of `s` as (its byte offset, the column it starts at), and
/// the width of `s`.
pub fn columns(s: &str) -> (Vec<(usize, usize)>, usize) {
    let mut out = Vec::with_capacity(s.len());
    let mut col = 0;
    for (b, ch) in s.char_indices() {
        out.push((b, col));
        col += ch.width().unwrap_or(0);
    }
    (out, col)
}

/// The column byte offset `b` of `s` starts at (`cs` from `columns`).
pub fn col_of(cs: &[(usize, usize)], width: usize, b: usize) -> usize {
    cs.iter().find(|&&(x, _)| x >= b).map_or(width, |&(_, c)| c)
}

/// The word under column `col` of line `i` (a double-click): Unicode word
/// boundaries, as Codex. A run of spaces is a word of its own, any other
/// mark a word by itself. None past the line's end.
pub fn word(line: &Line, i: usize, col: usize) -> Option<Sel> {
    let s = plain(line);
    let (cs, width) = columns(&s);
    if col >= width {
        return None;
    }
    let byte = cs[cs.iter().rposition(|&(_, c)| c <= col)?].0;
    let r = s.split_word_bound_indices().map(|(b, w)| b..b + w.len()).find(|r| r.contains(&byte))?;
    let (a, b) = (col_of(&cs, width, r.start), col_of(&cs, width, r.end));
    Some(Sel { anchor: Spot { line: i, col: a }, head: Spot { line: i, col: b } })
}

/// The marked text. Each line's trailing spaces go; a line clipped at the
/// preview's edge comes whole when the mark runs past its end; `wraps`
/// (the transcript's, else empty) join wrapped paragraphs back up.
pub fn text(lines: &[Line], wraps: &[Option<Wrap>], sel: &Sel) -> String {
    let (s, e) = sel.ends();
    let mut out = String::new();
    if lines.is_empty() {
        return out;
    }
    for (i, line) in lines.iter().enumerate().take(e.line + 1).skip(s.line) {
        let (mut a, b) = sel.cols(i).unwrap_or((0, 0));
        if i > s.line {
            out.truncate(out.trim_end_matches([' ', '\t']).len());
            match wraps.get(i).copied().flatten() {
                Some(w) => {
                    if w.space {
                        out.push(' ');
                    }
                    a = a.max(w.indent);
                }
                None => out.push('\n'),
            }
        }
        let line = plain(line);
        let (cs, _) = columns(&line);
        for (k, &(byte, col)) in cs.iter().enumerate() {
            if col >= a && col < b {
                out.push_str(&line[byte..cs.get(k + 1).map_or(line.len(), |x| x.0)]);
            }
        }
    }
    out.truncate(out.trim_end().len());
    out
}

/// Put `text` on the clipboard.
pub fn copy(text: &str) -> Result<(), String> {
    let mut child = Command::new("pbcopy")
        // pbcopy reads bytes in the locale's encoding: say it's UTF-8.
        .env("LANG", "en_US.UTF-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("pbcopy: {e}"))?;
    let wrote = child.stdin.take().map(|mut i| i.write_all(text.as_bytes()));
    let status = child.wait().map_err(|e| format!("pbcopy: {e}"))?;
    match wrote {
        Some(Err(e)) => Err(format!("pbcopy: {e}")),
        _ if !status.success() => Err(format!("pbcopy: {status}")),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Style;

    fn l(s: &str) -> Line {
        vec![(s.to_string(), Style::new())]
    }

    fn word_at(s: &str, needle: &str) -> String {
        let line = l(s);
        let col = s.find(needle).unwrap();
        let sel = word(&line, 0, col).unwrap();
        text(&[line], &[], &sel)
    }

    #[test]
    fn words_split_as_codex_does() {
        let row = "  /init - create an AGENTS.md file";
        assert_eq!(word_at(row, "init"), "init");
        assert_eq!(word_at(row, "AGENTS"), "AGENTS.md");
        assert_eq!(word_at(row, "create"), "create");
        assert_eq!(word_at("claude-501/-Users", "-U"), "-");
        assert_eq!(word_at("v0.166.0 out", "166"), "v0.166.0");
        assert!(word(&l("ab"), 0, 5).is_none());
    }

    #[test]
    fn drag_is_half_open_and_lines_trim() {
        let lines = [l("  /init - create  "), l("  /status - show current")];
        let sel = Sel { anchor: Spot { line: 0, col: 2 }, head: Spot { line: 1, col: 19 } };
        assert_eq!(text(&lines, &[], &sel), "/init - create\n  /status - show cu");
        // Backwards gives the same text.
        let back = Sel { anchor: sel.head, head: sel.anchor };
        assert_eq!(text(&lines, &[], &back), text(&lines, &[], &sel));
        assert_eq!(text(&lines, &[], &Sel::line(1)), "  /status - show current");
    }

    #[test]
    fn wrapped_paragraphs_join() {
        let lines = [l("⏺ the quick brown"), l("  fox jumps"), l("  over"), l("  next para")];
        let w = |space| Some(Wrap { indent: 2, space });
        let wraps = [None, w(true), w(false), None];
        let sel = Sel { anchor: Spot { line: 0, col: 2 }, head: Spot { line: 3, col: EOL } };
        assert_eq!(text(&lines, &wraps, &sel), "the quick brown fox jumpsover\n  next para");
    }

    #[test]
    fn wide_characters_count_their_cells() {
        let lines = [l("界 src/a.ts")];
        let sel = word(&lines[0], 0, 3).unwrap();
        assert_eq!(sel.anchor.col, 3);
        assert_eq!(text(&lines, &[], &sel), "src");
    }
}
