//! Colors: the shared Rex palette (rex/.local/share/rex-theme). Inside Rex they are Rex's
//! current theme, on the terminal's own background; elsewhere jv's (Zed's One Dark), so ctab,
//! ct, al and jv read as one tool. Tab groups use Chrome's own group colors.

use ratatui::style::Color;
pub use crate::rex_theme::Theme;

pub struct Palette {
    pub fg: Color,
    pub bright: Color,
    pub muted: Color,
    pub dim: Color,
    pub border: Color,
    pub panel: Color,
    pub sel: Color,
    pub accent: Color,
    pub green: Color,
    pub yellow: Color,
    theme: Theme,
}

impl Palette {
    pub fn new(t: &Theme) -> Self {
        Palette {
            fg: t.fg.c(),
            bright: t.bright.c(),
            muted: t.muted.c(),
            dim: t.dim.c(),
            border: t.border.c(),
            panel: t.panel,
            sel: t.sel.c(),
            accent: t.accent.c(),
            green: t.green.c(),
            yellow: t.yellow.c(),
            theme: t.clone(),
        }
    }

    /// A Chrome tab group's color by its API name, in Chrome's shade for this background.
    pub fn group(&self, name: &str) -> Color {
        self.theme.group(name)
    }
}
