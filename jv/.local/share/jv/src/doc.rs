//! The diff pane as one long list of screen rows: every visible file stacked
//! GitHub-style, with wrapping already resolved for the current width.

use std::collections::HashMap;
use std::ops::Range;

use unicode_width::UnicodeWidthChar;

use crate::diff::FileDiff;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Note {
    Binary,
    Collapsed,
    Viewed,
    Large,
    ModeOnly,
    RenameOnly,
    Empty,
}

#[derive(Clone, Copy, Debug)]
pub enum Row {
    File { f: u32 },
    Note { f: u32, note: Note },
    Hunk { f: u32, h: u32 },
    /// Single-column line (unified view, or a file that only has one side).
    Uni { f: u32, h: u32, l: u32, seg: u16 },
    /// Split view: `p` indexes `Hunk::pairs`.
    Split { f: u32, h: u32, p: u32, seg: u16 },
    Blank,
}

impl Row {
    pub fn file(&self) -> Option<usize> {
        match *self {
            Row::File { f } | Row::Note { f, .. } | Row::Hunk { f, .. } | Row::Uni { f, .. } | Row::Split { f, .. } => {
                Some(f as usize)
            }
            Row::Blank => None,
        }
    }
}

/// Column budget for the diff pane. The last column is the scrollbar.
#[derive(Clone, Copy, Debug, Default)]
pub struct Geo {
    pub width: u16,
    pub split: bool,
    pub wrap: bool,
    /// Digits in the widest line number.
    pub nw: usize,
}

impl Geo {
    pub fn content(&self) -> usize {
        (self.width as usize).saturating_sub(1)
    }
    /// ` 12 ` single number column.
    pub fn gutter1(&self) -> usize {
        self.nw + 2
    }
    /// ` 12  13 ` old + new number columns.
    pub fn gutter2(&self) -> usize {
        self.nw * 2 + 3
    }
    /// Two cells for the +/- sign and a space.
    pub const SIGN: usize = 2;

    pub fn uni_code_w(&self, single: bool) -> usize {
        let g = if single { self.gutter1() } else { self.gutter2() };
        self.content().saturating_sub(g + Self::SIGN).max(8)
    }
    pub fn left_w(&self) -> usize {
        self.content().saturating_sub(1) / 2
    }
    pub fn right_w(&self) -> usize {
        self.content().saturating_sub(1) - self.left_w()
    }
    pub fn side_code_w(&self, right: bool) -> usize {
        let w = if right { self.right_w() } else { self.left_w() };
        w.saturating_sub(self.gutter1() + Self::SIGN).max(8)
    }
}

pub struct Doc {
    pub rows: Vec<Row>,
    /// Row of each file's header, by file index; `usize::MAX` if not shown.
    pub file_row: Vec<usize>,
    /// First row showing (file, hunk, line).
    pub line_row: HashMap<(u32, u32, u32), usize>,
    pub geo: Geo,
}

impl Doc {
    pub fn empty() -> Self {
        Doc { rows: Vec::new(), file_row: Vec::new(), line_row: HashMap::new(), geo: Geo::default() }
    }
}

pub fn build(files: &[FileDiff], order: &[usize], note_for: impl Fn(usize) -> Option<Note>, geo: Geo) -> Doc {
    let mut rows = Vec::new();
    let mut file_row = vec![usize::MAX; files.len()];
    let mut line_row = HashMap::new();
    let wrap = |s: &str, w: usize| if geo.wrap { wrap_count(s, w) } else { 1 };

    for &fi in order {
        let f = &files[fi];
        let fu = fi as u32;
        file_row[fi] = rows.len();
        rows.push(Row::File { f: fu });
        let note = note_for(fi).or_else(|| {
            if f.binary {
                Some(Note::Binary)
            } else if f.hunks.is_empty() {
                Some(if !f.mode.1.is_empty() {
                    Note::ModeOnly
                } else if f.old_path.is_some() {
                    Note::RenameOnly
                } else {
                    Note::Empty
                })
            } else {
                None
            }
        });
        if let Some(note) = note {
            rows.push(Row::Note { f: fu, note });
            rows.push(Row::Blank);
            continue;
        }
        let split = geo.split && !f.one_sided();
        for (hi, h) in f.hunks.iter().enumerate() {
            let hu = hi as u32;
            rows.push(Row::Hunk { f: fu, h: hu });
            if split {
                let (lw, rw) = (geo.side_code_w(false), geo.side_code_w(true));
                for (pi, &(lo, ro)) in h.pairs.iter().enumerate() {
                    let ls = lo.map_or(0, |l| wrap(&h.lines[l].text, lw));
                    let rs = ro.map_or(0, |l| wrap(&h.lines[l].text, rw));
                    for l in [lo, ro].into_iter().flatten() {
                        line_row.entry((fu, hu, l as u32)).or_insert(rows.len());
                    }
                    for seg in 0..ls.max(rs).max(1) {
                        rows.push(Row::Split { f: fu, h: hu, p: pi as u32, seg: seg as u16 });
                    }
                }
            } else {
                let w = geo.uni_code_w(f.one_sided());
                for (li, l) in h.lines.iter().enumerate() {
                    line_row.insert((fu, hu, li as u32), rows.len());
                    for seg in 0..wrap(&l.text, w) {
                        rows.push(Row::Uni { f: fu, h: hu, l: li as u32, seg: seg as u16 });
                    }
                }
            }
        }
        rows.push(Row::Blank);
    }
    Doc { rows, file_row, line_row, geo }
}

/// Byte ranges of each wrapped segment; always at least one.
pub fn wrap_ranges(text: &str, w: usize) -> Vec<Range<usize>> {
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

pub fn wrap_count(text: &str, w: usize) -> usize {
    let (mut n, mut col) = (1, 0);
    for c in text.chars() {
        let cw = c.width().unwrap_or(0);
        if col + cw > w && col > 0 {
            n += 1;
            col = 0;
        }
        col += cw;
    }
    n
}
