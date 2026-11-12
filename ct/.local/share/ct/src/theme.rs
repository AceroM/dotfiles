//! ct's and tg's colors. Inside Rex they are Rex's own: the theme Rex's settings name for the
//! current macOS appearance (`Workspace.darkThemeID` / `Workspace.lightThemeID`), read from the
//! design tokens in Rex's app bundle. The box then sits on Rex's terminal background with Rex's
//! border, text, selection and status colors, and follows Rex when its theme changes. Anywhere
//! else (or with CT_THEME=onedark): Zed's One Dark on $CT_BG / $JV_BG (#282c34 by default).

use std::path::PathBuf;

use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::string::{CFString, CFStringRef};
use ratatui::style::Color;
use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    /// `#e6edf3` or `e6edf3`.
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
    /// Where the colors came from: `rex merino-dark`, `one dark`.
    pub name: String,
    /// A light background: tab-group colors take Chrome's light-mode shades.
    pub light: bool,
    pub fg: Color,
    pub bright: Color,
    pub muted: Color,
    pub dim: Color,
    /// Behind the box.
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
}

/// Rex's colors inside Rex, One Dark elsewhere.
pub fn palette() -> Palette {
    let forced = std::env::var("CT_THEME").unwrap_or_default();
    if forced != "onedark" && (forced == "rex" || in_rex()) {
        match rex_palette() {
            Ok(p) => return p,
            Err(e) if forced == "rex" => eprintln!("ct: no Rex theme ({e}); using One Dark"),
            Err(_) => {}
        }
    }
    let bg = ["CT_BG", "JV_BG"].iter().find_map(|k| std::env::var(k).ok().and_then(|s| Rgb::parse(&s))).unwrap_or(Rgb(0x28, 0x2c, 0x34));
    one_dark(bg)
}

fn in_rex() -> bool {
    std::env::var("TERM_PROGRAM").is_ok_and(|t| t == "rex") || std::env::var_os("REX_BLOCK").is_some()
}

fn one_dark(bg: Rgb) -> Palette {
    let fg = Rgb(0xab, 0xb2, 0xbf);
    let accent = Rgb(0x74, 0xad, 0xe8);
    let red = Rgb(0xe0, 0x6c, 0x75);
    Palette {
        name: "one dark".to_string(),
        light: false,
        fg: fg.c(),
        bright: Rgb(0xdc, 0xe0, 0xe5).c(),
        muted: bg.mix(fg, 0.62).c(),
        dim: bg.mix(fg, 0.40).c(),
        panel: bg.mix(fg, 0.055).c(),
        border: accent.c(),
        sel: bg.mix(accent, 0.24).c(),
        doomed: bg.mix(red, 0.14).c(),
        accent: accent.c(),
        green: Rgb(0x98, 0xc3, 0x79).c(),
        yellow: Rgb(0xe5, 0xc0, 0x7b).c(),
        red: red.c(),
    }
}

/// The current Rex theme's tokens (`--super-*`, Rex's CSS variables) as a palette.
fn rex_palette() -> Result<Palette, String> {
    let dark = pref("AppleInterfaceStyle", None).is_some_and(|s| s == "Dark");
    let key = if dark { "Workspace.darkThemeID" } else { "Workspace.lightThemeID" };
    let id = pref(key, Some("com.superlogical.rex")).unwrap_or_else(|| if dark { "merino-dark" } else { "merino-light" }.to_string());
    let path = themes_json().ok_or("Rex's themes.json isn't in /Applications/Rex*.app")?;
    let themes: Value = serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let theme = themes.as_array().and_then(|a| a.iter().find(|t| t["id"] == id.as_str())).ok_or(format!("no theme {id}"))?;
    let vars = &theme["cssVariables"];
    let bg = css(vars, "--super-term-bg", None).ok_or("no --super-term-bg")?;
    let get = |k: &str| css(vars, k, Some(bg)).ok_or(format!("no {k}"));
    let text = get("--super-text")?;
    Ok(Palette {
        name: format!("rex {id}"),
        light: theme["appearance"] == "light",
        fg: bg.mix(text, 0.84).c(),
        bright: text.c(),
        muted: get("--super-text-secondary")?.c(),
        dim: get("--super-text-tertiary")?.c(),
        panel: bg.c(),
        border: get("--super-border-strong")?.c(),
        sel: get("--super-accent-container")?.c(),
        doomed: get("--super-danger-container")?.c(),
        accent: get("--super-accent")?.c(),
        green: get("--super-success")?.c(),
        yellow: get("--super-warning")?.c(),
        red: get("--super-danger")?.c(),
    })
}

/// Rex's design tokens. The newest themes.json among the Rex apps installed (Rex, Rex Beta, …).
fn themes_json() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = [PathBuf::from("/Applications"), home.join("Applications")]
        .iter()
        .flat_map(|d| std::fs::read_dir(d).into_iter().flatten().flatten())
        .filter(|e| e.file_name().to_string_lossy().starts_with("Rex") && e.file_name().to_string_lossy().ends_with(".app"))
        .map(|e| e.path().join("Contents/Resources/SuperUI_SuperDesignTokens.bundle/Contents/Resources/themes.json"))
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .collect();
    found.sort();
    found.pop().map(|(_, p)| p)
}

/// One CSS variable: `13 17 23`, `rgb(52 133 250)`, `rgb(52 133 250 / 0.151)` (blended over
/// `over`), or `#e6edf3`.
fn css(vars: &Value, key: &str, over: Option<Rgb>) -> Option<Rgb> {
    let s = vars[key].as_str()?.trim();
    if s.starts_with('#') {
        return Rgb::parse(s);
    }
    let inner = s.strip_prefix("rgb(").and_then(|r| r.strip_suffix(')')).unwrap_or(s);
    let (rgb, alpha) = match inner.split_once('/') {
        Some((c, a)) => (c, a.trim().parse::<f32>().ok()?),
        None => (inner, 1.0),
    };
    let n: Vec<u8> = rgb.split_whitespace().filter_map(|x| x.parse().ok()).collect();
    let [r, g, b] = n[..] else { return None };
    let c = Rgb(r, g, b);
    Some(match over {
        Some(o) if alpha < 1.0 => o.mix(c, alpha),
        _ => c,
    })
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFPreferencesCopyAppValue(key: CFStringRef, app: CFStringRef) -> CFTypeRef;
    static kCFPreferencesAnyApplication: CFStringRef;
}

/// A string preference: an app's (`com.superlogical.rex`), or the global domain's.
fn pref(key: &str, app: Option<&str>) -> Option<String> {
    let k = CFString::new(key);
    let app_s = app.map(CFString::new);
    let domain = match &app_s {
        Some(a) => a.as_concrete_TypeRef(),
        None => unsafe { kCFPreferencesAnyApplication },
    };
    let v = unsafe { CFPreferencesCopyAppValue(k.as_concrete_TypeRef(), domain) };
    if v.is_null() {
        return None;
    }
    let v = unsafe { CFType::wrap_under_create_rule(v) };
    v.downcast::<CFString>().map(|s| s.to_string())
}

impl Palette {
    /// A Chrome tab-group color (`purple`, `cyan`, …) the way Chrome draws it on this background.
    pub fn group(&self, name: &str) -> Color {
        let (r, g, b) = if self.light {
            match name {
                "grey" => (0x5f, 0x63, 0x68),
                "blue" => (0x1a, 0x73, 0xe8),
                "red" => (0xd9, 0x30, 0x25),
                "yellow" => (0xe3, 0x74, 0x00),
                "green" => (0x18, 0x80, 0x38),
                "pink" => (0xd0, 0x18, 0x84),
                "purple" => (0x93, 0x34, 0xe6),
                "cyan" => (0x00, 0x7b, 0x83),
                "orange" => (0xe8, 0x71, 0x0a),
                _ => (0x5f, 0x63, 0x68),
            }
        } else {
            match name {
                "grey" => (0xbd, 0xc1, 0xc6),
                "blue" => (0x8a, 0xb4, 0xf8),
                "red" => (0xf2, 0x8b, 0x82),
                "yellow" => (0xfd, 0xd6, 0x63),
                "green" => (0x81, 0xc9, 0x95),
                "pink" => (0xff, 0x8b, 0xcb),
                "purple" => (0xc5, 0x8a, 0xf9),
                "cyan" => (0x78, 0xd9, 0xec),
                "orange" => (0xfc, 0xad, 0x70),
                _ => (0xab, 0xb2, 0xbf),
            }
        };
        Color::Rgb(r, g, b)
    }
}
