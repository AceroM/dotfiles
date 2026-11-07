//! Syntax highlighting with syntect — the same engine and the same bat
//! syntaxes/themes delta uses (via two-face), so TS/TSX files get real
//! grammars instead of plain text.

use std::ops::Range;

use ratatui::style::Color;
use syntect::easy::HighlightLines;
use syntect::highlighting::{FontStyle, Theme};
use syntect::parsing::{SyntaxReference, SyntaxSet};
use two_face::theme::{EmbeddedLazyThemeSet, EmbeddedThemeName};

use crate::diff::{FileDiff, Kind};

#[derive(Clone, Debug)]
pub struct Tok {
    pub range: Range<usize>,
    pub fg: Color,
    pub bold: bool,
    pub italic: bool,
}

/// Tokens per line, indexed `[hunk][line]`. Empty when the file has no
/// grammar (or is too big to bother), which renders as plain text.
pub type FileHl = Vec<Vec<Vec<Tok>>>;

pub struct Hl {
    ss: SyntaxSet,
    theme: Theme,
}

pub const DEFAULT_THEME: &str = "TwoDark";

pub fn theme_names() -> Vec<&'static str> {
    EmbeddedLazyThemeSet::theme_names().iter().map(|n| n.as_name()).collect()
}

fn find_theme(name: &str) -> Option<EmbeddedThemeName> {
    let norm = |s: &str| s.to_lowercase().replace([' ', '-', '_', '(', ')', '.'], "");
    let want = norm(name);
    EmbeddedLazyThemeSet::theme_names().iter().copied().find(|n| norm(n.as_name()) == want)
}

impl Hl {
    pub fn new(theme: &str) -> Result<Self, String> {
        let name = find_theme(theme).ok_or_else(|| {
            format!("unknown theme {theme:?}; `jv --themes` lists them")
        })?;
        let ts = two_face::theme::extra();
        Ok(Hl { ss: two_face::syntax::extra_newlines(), theme: ts.get(name).clone() })
    }

    fn syntax_for(&self, f: &FileDiff) -> Option<&SyntaxReference> {
        let name = f.name();
        let by_ext = name.rsplit_once('.').and_then(|(_, ext)| self.ss.find_syntax_by_extension(ext));
        by_ext
            .or_else(|| self.ss.find_syntax_by_extension(name))
            .or_else(|| {
                let first = f.hunks.first()?.lines.first()?;
                self.ss.find_syntax_by_first_line(&first.text)
            })
            .filter(|s| s.name != "Plain Text")
    }

    pub fn file(&self, f: &FileDiff) -> FileHl {
        let Some(syn) = self.syntax_for(f) else { return Vec::new() };
        // Minified or gigantic files: syntect is linear but slow on huge lines.
        if f.line_count() > 40_000 || f.hunks.iter().any(|h| h.lines.iter().any(|l| l.text.len() > 4000)) {
            return Vec::new();
        }
        let mut buf = String::new();
        let mut out = Vec::with_capacity(f.hunks.len());
        for h in &f.hunks {
            // Fresh state per hunk: the lines between hunks aren't in the diff,
            // so a hunk that ends inside a `/** … */` would otherwise leave
            // every later hunk highlighted as a comment.
            let mut old = HighlightLines::new(syn, &self.theme);
            let mut new = HighlightLines::new(syn, &self.theme);
            let mut lines = Vec::with_capacity(h.lines.len());
            for l in &h.lines {
                buf.clear();
                buf.push_str(&l.text);
                buf.push('\n');
                let regions = match l.kind {
                    Kind::Ctx => {
                        let _ = old.highlight_line(&buf, &self.ss);
                        new.highlight_line(&buf, &self.ss)
                    }
                    Kind::Del => old.highlight_line(&buf, &self.ss),
                    Kind::Add => new.highlight_line(&buf, &self.ss),
                };
                let mut toks = Vec::new();
                if let Ok(regions) = regions {
                    let mut at = 0;
                    for (style, s) in regions {
                        let end = (at + s.len()).min(l.text.len());
                        if end > at {
                            toks.push(Tok {
                                range: at..end,
                                fg: Color::Rgb(style.foreground.r, style.foreground.g, style.foreground.b),
                                bold: style.font_style.contains(FontStyle::BOLD),
                                italic: style.font_style.contains(FontStyle::ITALIC),
                            });
                        }
                        at += s.len();
                    }
                }
                lines.push(toks);
            }
            out.push(lines);
        }
        out
    }
}
