//! Colors: the shared Rex palette (rex/.local/share/rex-theme), so o, al, jv, ctab and ct read
//! as one tool: Rex's current theme inside Rex, Zed's One Dark elsewhere.

use ratatui::style::Color;
pub use crate::rex_theme::Theme;

/// Text in the terminal's own color; these for what isn't.
pub struct Palette {
    pub muted: Color,
    pub dim: Color,
    pub sel: Color,
    pub accent: Color,
    pub green: Color,
    pub red: Color,
    pub yellow: Color,
}

impl Palette {
    pub fn new(t: &Theme) -> Self {
        Palette {
            muted: t.muted.c(),
            dim: t.dim.c(),
            sel: t.sel.c(),
            accent: t.accent.c(),
            green: t.green.c(),
            red: t.red.c(),
            yellow: t.yellow.c(),
        }
    }
}
