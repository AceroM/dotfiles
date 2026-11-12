//! Colors: the shared Rex palette (rex/.local/share/rex-theme). Inside Rex they are Rex's
//! current theme, on the terminal's own background; elsewhere jv's (Zed's One Dark), so al, jv,
//! ctab and ct read as one tool.

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
    pub accent: Color,
    pub green: Color,
    pub green_dim: Color,
    pub red: Color,
    pub yellow: Color,
}

impl Palette {
    pub fn new(t: &Theme) -> Self {
        Palette {
            bg: t.bg,
            fg: t.fg.c(),
            bright: t.bright.c(),
            muted: t.muted.c(),
            dim: t.dim.c(),
            border: t.border.c(),
            panel: t.panel,
            sel: t.sel.c(),
            accent: t.accent.c(),
            green: t.green.c(),
            green_dim: t.bg.mix(t.green, 0.72).c(),
            red: t.red.c(),
            yellow: t.yellow.c(),
        }
    }
}
