//! Colors. Chrome follows Zed's One Dark (the terminal theme in ghostty/), and
//! the diff tints are GitHub's green/red blended into the background, so they
//! read as tints rather than the solid blocks delta paints by default.

use ratatui::style::Color;

#[derive(Clone, Copy, Debug)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    pub fn parse(s: &str) -> Option<Rgb> {
        let s = s.trim().trim_start_matches('#');
        if s.len() != 6 {
            return None;
        }
        let v = u32::from_str_radix(s, 16).ok()?;
        Some(Rgb((v >> 16) as u8, (v >> 8) as u8, v as u8))
    }

    pub fn mix(self, o: Rgb, t: f32) -> Rgb {
        let f = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t).round().clamp(0.0, 255.0) as u8;
        Rgb(f(self.0, o.0), f(self.1, o.1), f(self.2, o.2))
    }

    pub fn c(self) -> Color {
        Color::Rgb(self.0, self.1, self.2)
    }
}

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
    pub fn new(bg: Rgb) -> Self {
        let fg = Rgb(0xab, 0xb2, 0xbf);
        let add = Rgb(0x2e, 0xa0, 0x43);
        let del = Rgb(0xf8, 0x51, 0x49);
        let green = Rgb(0x98, 0xc3, 0x79);
        let red = Rgb(0xe0, 0x6c, 0x75);
        let yellow = Rgb(0xe5, 0xc0, 0x7b);
        let blue = Rgb(0x61, 0xaf, 0xef);
        let accent = Rgb(0x74, 0xad, 0xe8);
        Palette {
            bg,
            fg: fg.c(),
            bright: Rgb(0xdc, 0xe0, 0xe5).c(),
            muted: bg.mix(fg, 0.62).c(),
            dim: bg.mix(fg, 0.40).c(),
            border: bg.mix(fg, 0.16).c(),
            panel: bg.mix(fg, 0.055).c(),
            sel: bg.mix(accent, 0.24).c(),
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
