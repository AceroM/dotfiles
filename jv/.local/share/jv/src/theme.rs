//! Colors. Chrome comes from the shared Rex palette (rex/.local/share/rex-theme): Rex's current
//! theme inside Rex, on the terminal's own background; Zed's One Dark elsewhere. The diff tints
//! are GitHub's green/red blended into the background, so they read as tints rather than the
//! solid blocks delta paints by default.

use ratatui::style::Color;
pub use crate::rex_theme::{Rgb, Theme};

pub struct Palette {
    pub bg: Rgb,
    pub fg: Color,
    pub bright: Color,
    pub muted: Color,
    pub dim: Color,
    pub border: Color,
    pub panel: Color,
    pub sel: Color,
    pub sel_dim: Color,
    /// Mouse-selected text in the diff.
    pub sel_text: Color,
    pub accent: Color,
    pub green: Color,
    pub red: Color,
    pub yellow: Color,
    pub blue: Color,
    pub green_dim: Color,
    pub red_dim: Color,
    pub line_nr: Color,
    pub add_bg: Color,
    pub add_bg_soft: Color,
    pub add_emph: Color,
    pub add_gutter: Color,
    pub add_nr: Color,
    pub del_bg: Color,
    pub del_bg_soft: Color,
    pub del_emph: Color,
    pub del_gutter: Color,
    pub del_nr: Color,
    pub hunk_bg: Color,
    pub hunk_fg: Color,
    pub filler: Color,
    pub search_bg: Color,
    pub search_cur_bg: Color,
    pub search_cur_fg: Color,
}

impl Palette {
    pub fn new(t: &Theme) -> Self {
        let (bg, fg) = (t.bg, t.fg);
        let add = Rgb(0x2e, 0xa0, 0x43);
        let del = Rgb(0xf8, 0x51, 0x49);
        let (green, red, yellow, blue, accent) = (t.green, t.red, t.yellow, t.blue, t.accent);
        Palette {
            bg,
            fg: fg.c(),
            bright: t.bright.c(),
            muted: t.muted.c(),
            dim: t.dim.c(),
            border: t.border.c(),
            panel: t.panel,
            sel: t.sel.c(),
            sel_dim: bg.mix(fg, 0.13).c(),
            sel_text: bg.mix(accent, 0.40).c(),
            accent: accent.c(),
            green: green.c(),
            red: red.c(),
            yellow: yellow.c(),
            blue: blue.c(),
            green_dim: bg.mix(green, 0.72).c(),
            red_dim: bg.mix(red, 0.72).c(),
            line_nr: bg.mix(fg, 0.30).c(),
            add_bg: bg.mix(add, 0.14).c(),
            add_bg_soft: bg.mix(add, 0.055).c(),
            add_emph: bg.mix(add, 0.36).c(),
            add_gutter: bg.mix(add, 0.24).c(),
            add_nr: bg.mix(green, 0.85).c(),
            del_bg: bg.mix(del, 0.13).c(),
            del_bg_soft: bg.mix(del, 0.05).c(),
            del_emph: bg.mix(del, 0.34).c(),
            del_gutter: bg.mix(del, 0.22).c(),
            del_nr: bg.mix(red, 0.85).c(),
            hunk_bg: bg.mix(accent, 0.075).c(),
            hunk_fg: bg.mix(accent, 0.70).c(),
            filler: bg.mix(Rgb(0, 0, 0), 0.20).c(),
            search_bg: bg.mix(yellow, 0.38).c(),
            search_cur_bg: yellow.c(),
            search_cur_fg: bg.c(),
        }
    }
}
