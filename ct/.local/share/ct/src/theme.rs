//! ct's and tg's colors, from the palette every tool shares (rex_theme.rs, a symlink to
//! rex/.local/share/rex-theme/src/lib.rs): Rex's theme inside Rex, Zed's One Dark on $CT_BG /
//! $JV_BG elsewhere, TUI_THEME to choose. This file only names those colors the way ct and tg
//! draw with them.

use ratatui::style::Color;

use crate::rex_theme::{self, Theme};

pub struct Palette {
    pub fg: Color,
    pub bright: Color,
    pub muted: Color,
    pub dim: Color,
    /// Behind the box: Color::Reset inside Rex, so it's the pane's own background.
    pub panel: Color,
    pub border: Color,
    /// Behind the cursor's row.
    pub sel: Color,
    /// Behind a marked row (the next `;` takes it).
    pub doomed: Color,
    pub accent: Color,
    pub green: Color,
    pub yellow: Color,
    pub red: Color,
    theme: Theme,
}

pub fn palette() -> Palette {
    let t = rex_theme::theme(&["CT_BG", "JV_BG"]);
    Palette {
        fg: t.fg.c(),
        bright: t.bright.c(),
        muted: t.muted.c(),
        dim: t.dim.c(),
        panel: t.panel,
        border: t.border.c(),
        sel: t.sel.c(),
        doomed: t.danger_bg.c(),
        accent: t.accent.c(),
        green: t.green.c(),
        yellow: t.yellow.c(),
        red: t.red.c(),
        theme: t,
    }
}

impl Palette {
    /// A Chrome tab-group color (`purple`, `cyan`, …) as Chrome draws it on this background.
    pub fn group(&self, name: &str) -> Color {
        self.theme.group(name)
    }
}
