//! Colors: jv's (Zed's One Dark, the terminal theme in ghostty/), so al, jv
//! and ctab read as one tool.

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
    pub accent: Color,
    pub green: Color,
    pub green_dim: Color,
    pub red: Color,
    pub yellow: Color,
}

impl Palette {
    pub fn new(bg: Rgb) -> Self {
        let fg = Rgb(0xab, 0xb2, 0xbf);
        let green = Rgb(0x98, 0xc3, 0x79);
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
            accent: accent.c(),
            green: green.c(),
            green_dim: bg.mix(green, 0.72).c(),
            red: Rgb(0xe0, 0x6c, 0x75).c(),
            yellow: Rgb(0xe5, 0xc0, 0x7b).c(),
        }
    }
}
