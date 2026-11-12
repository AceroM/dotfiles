//! The colors ctab, tk, al, jv, o, ct and tg draw with, so they read as one tool and as part of the
//! terminal they run in.
//!
//! Inside Rex they are Rex's own: the theme Rex's settings name for the current macOS appearance
//! (`Workspace.darkThemeID` / `Workspace.lightThemeID`), read from the design tokens in Rex's app
//! bundle. The tools then draw on the terminal's own background (`panel` is `Color::Reset`), with
//! Rex's terminal text and ANSI colors and its UI accent, border and selection, and follow Rex when
//! its theme changes. Anywhere else: Zed's One Dark on the first `*_BG` variable the tool names
//! that is set, `#282c34` by default, exactly as the tools drew before.
//!
//! `TUI_THEME` overrides the choice: `onedark`, `rex`, or a Rex theme id (`merino-light`).
//!
//! Each tool takes this file as a module, `src/rex_theme.rs`, a symlink here, rather than as a
//! path dependency: Cargo resolves `../` lexically, so a path dependency breaks when a tool is
//! built from its stowed folder (`~/.local/share/o`). A symlink resolves from either place. The
//! tools all depend on ratatui 0.30 and serde_json already.

#![allow(dead_code)]

use std::path::PathBuf;

use ratatui::style::Color;
use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
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

    /// `t` of the way from `self` to `o`.
    pub fn mix(self, o: Rgb, t: f32) -> Rgb {
        let f = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t).round().clamp(0.0, 255.0) as u8;
        Rgb(f(self.0, o.0), f(self.1, o.1), f(self.2, o.2))
    }

    pub fn c(self) -> Color {
        Color::Rgb(self.0, self.1, self.2)
    }
}

/// The base colors. Each tool derives the rest (diff tints, dimmed shades) by mixing these.
#[derive(Clone, Debug)]
pub struct Theme {
    /// Where the colors came from: `rex merino-dark`, `one dark`.
    pub name: String,
    /// Drawn from Rex's theme.
    pub rex: bool,
    /// A light background.
    pub light: bool,
    /// The terminal's background: what every mix starts from.
    pub bg: Rgb,
    /// Behind the tool's boxes. `Color::Reset` inside Rex, so empty cells are the terminal's own.
    pub panel: Color,
    /// Body text.
    pub fg: Rgb,
    /// Titles and the selected row's text.
    pub bright: Rgb,
    pub muted: Rgb,
    pub dim: Rgb,
    pub border: Rgb,
    pub accent: Rgb,
    /// Behind the cursor's row.
    pub sel: Rgb,
    /// Behind a row about to be closed or deleted.
    pub danger_bg: Rgb,
    pub green: Rgb,
    pub yellow: Rgb,
    pub red: Rgb,
    pub blue: Rgb,
}

/// The tool's colors: Rex's inside Rex, One Dark on the first set `bg_vars` (`["CTAB_BG",
/// "JV_BG"]`) elsewhere.
pub fn theme(bg_vars: &[&str]) -> Theme {
    let forced = std::env::var("TUI_THEME").unwrap_or_default();
    let forced = forced.trim();
    if forced != "onedark" && (!forced.is_empty() || in_rex()) {
        let id = if forced.is_empty() || forced == "rex" { None } else { Some(forced) };
        match rex(id) {
            Ok(t) => return t,
            Err(e) if !forced.is_empty() => eprintln!("no Rex theme ({e}); using One Dark"),
            Err(_) => {}
        }
    }
    let bg = bg_vars.iter().find_map(|k| std::env::var(k).ok().and_then(|s| Rgb::parse(&s))).unwrap_or(Rgb(0x28, 0x2c, 0x34));
    one_dark(bg)
}

/// Running in a Rex pane.
pub fn in_rex() -> bool {
    std::env::var("TERM_PROGRAM").is_ok_and(|t| t == "rex") || std::env::var_os("REX_BLOCK").is_some()
}

/// Zed's One Dark, the shades the tools always used.
pub fn one_dark(bg: Rgb) -> Theme {
    let fg = Rgb(0xab, 0xb2, 0xbf);
    let accent = Rgb(0x74, 0xad, 0xe8);
    let red = Rgb(0xe0, 0x6c, 0x75);
    Theme {
        name: "one dark".to_string(),
        rex: false,
        light: false,
        bg,
        panel: bg.mix(fg, 0.055).c(),
        fg,
        bright: Rgb(0xdc, 0xe0, 0xe5),
        muted: bg.mix(fg, 0.62),
        dim: bg.mix(fg, 0.40),
        border: bg.mix(fg, 0.16),
        accent,
        sel: bg.mix(accent, 0.24),
        danger_bg: bg.mix(red, 0.14),
        green: Rgb(0x98, 0xc3, 0x79),
        yellow: Rgb(0xe5, 0xc0, 0x7b),
        red,
        blue: Rgb(0x61, 0xaf, 0xef),
    }
}

/// A Rex theme: the one Rex shows now, or `id`.
fn rex(id: Option<&str>) -> Result<Theme, String> {
    let id = match id {
        Some(id) => id.to_string(),
        None => {
            let dark = pref("AppleInterfaceStyle", None).is_some_and(|s| s == "Dark");
            let key = if dark { "Workspace.darkThemeID" } else { "Workspace.lightThemeID" };
            pref(key, Some("com.superlogical.rex")).unwrap_or_else(|| if dark { "merino-dark" } else { "merino-light" }.to_string())
        }
    };
    let path = themes_json().ok_or("Rex's themes.json isn't in /Applications/Rex*.app")?;
    let vars = tokens(&path, &id)?;
    let get = |k: &str, over: Option<Rgb>| css(&vars, k, over).ok_or(format!("{id} has no {k}"));
    let bg = get("--super-term-bg", None)?;
    let tok = |k: &str| get(k, Some(bg));
    // The terminal's own colors (tt-*), else the UI's.
    let term = |tt: &str, ui: &str| tok(tt).or_else(|_| tok(ui));
    let bright = term("--super-tt-fg", "--super-text")?;
    Ok(Theme {
        name: format!("rex {id}"),
        rex: true,
        light: vars.get("appearance").and_then(|v| v.as_str()) == Some("light"),
        bg,
        panel: Color::Reset,
        fg: bg.mix(bright, 0.84),
        bright,
        muted: tok("--super-text-secondary")?,
        dim: tok("--super-text-tertiary")?,
        border: tok("--super-border-strong")?,
        accent: tok("--super-accent")?,
        sel: tok("--super-accent-container")?,
        danger_bg: tok("--super-danger-container")?,
        green: term("--super-tt-2", "--super-success")?,
        yellow: term("--super-tt-3", "--super-warning")?,
        red: term("--super-tt-1", "--super-danger")?,
        blue: term("--super-tt-4", "--super-info")?,
    })
}

/// Rex's design tokens. The newest themes.json among the Rex apps installed (Rex, Rex Beta, …).
fn themes_json() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = [PathBuf::from("/Applications"), home.join("Applications")]
        .iter()
        .flat_map(|d| std::fs::read_dir(d).into_iter().flatten().flatten())
        .filter(|e| {
            let n = e.file_name();
            let n = n.to_string_lossy();
            n.starts_with("Rex") && n.ends_with(".app")
        })
        .map(|e| e.path().join("Contents/Resources/SuperUI_SuperDesignTokens.bundle/Contents/Resources/themes.json"))
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .collect();
    found.sort();
    found.pop().map(|(_, p)| p)
}

/// One theme's CSS variables, plus its `appearance`. themes.json is 2.5 MB, so the theme is
/// cached in ~/Library/Caches/rex-theme, keyed by the file's path and modification time.
fn tokens(path: &PathBuf, id: &str) -> Result<serde_json::Map<String, Value>, String> {
    let stamp = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let key = format!("{}\n{stamp}", path.display());
    let cache = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Caches/rex-theme").join(format!("{id}.json")));
    if let Some(c) = &cache {
        if let Ok(Value::Object(mut o)) = std::fs::read(c).map_err(|_| ()).and_then(|b| serde_json::from_slice(&b).map_err(|_| ())) {
            if o.get("key").and_then(|k| k.as_str()) == Some(key.as_str()) {
                if let Some(Value::Object(vars)) = o.remove("vars") {
                    return Ok(vars);
                }
            }
        }
    }
    let themes: Value = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let theme = themes.as_array().and_then(|a| a.iter().find(|t| t["id"] == id)).ok_or(format!("no Rex theme {id}"))?;
    let mut vars = theme["cssVariables"].as_object().cloned().ok_or(format!("{id} has no cssVariables"))?;
    vars.insert("appearance".to_string(), theme["appearance"].clone());
    if let Some(c) = &cache {
        let body = serde_json::json!({ "key": key, "vars": vars });
        if let Some(dir) = c.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Write then rename, so two tools starting at once never read half a file.
        let tmp = c.with_extension(format!("{}.tmp", std::process::id()));
        if std::fs::write(&tmp, body.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, c);
        }
    }
    Ok(vars)
}

/// One CSS variable: `13 17 23`, `rgb(52 133 250)`, `rgb(52 133 250 / 0.151)` (blended over
/// `over`), or `#e6edf3`.
fn css(vars: &serde_json::Map<String, Value>, key: &str, over: Option<Rgb>) -> Option<Rgb> {
    let s = vars.get(key)?.as_str()?.trim();
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

impl Theme {
    /// A Chrome tab-group color (`purple`, `cyan`, …) the way Chrome draws it on this background.
    pub fn group(&self, name: &str) -> Color {
        let (r, g, b) = if self.light {
            match name {
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

// ---- macOS preferences ---------------------------------------------------------

type CFRef = *const std::ffi::c_void;
const UTF8: u32 = 0x0800_0100;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFPreferencesAnyApplication: CFRef;
    fn CFStringCreateWithBytes(alloc: CFRef, bytes: *const u8, len: isize, encoding: u32, external: u8) -> CFRef;
    fn CFPreferencesCopyAppValue(key: CFRef, app: CFRef) -> CFRef;
    fn CFGetTypeID(cf: CFRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFStringGetCString(s: CFRef, buf: *mut u8, size: isize, encoding: u32) -> u8;
    fn CFRelease(cf: CFRef);
}

fn cfstr(s: &str) -> CFRef {
    unsafe { CFStringCreateWithBytes(std::ptr::null(), s.as_ptr(), s.len() as isize, UTF8, 0) }
}

/// A string preference: an app's (`com.superlogical.rex`), or the global domain's.
fn pref(key: &str, app: Option<&str>) -> Option<String> {
    unsafe {
        let k = cfstr(key);
        let a = app.map(cfstr);
        let v = CFPreferencesCopyAppValue(k, a.unwrap_or(kCFPreferencesAnyApplication));
        CFRelease(k);
        if let Some(a) = a {
            CFRelease(a);
        }
        if v.is_null() {
            return None;
        }
        let mut out = None;
        if CFGetTypeID(v) == CFStringGetTypeID() {
            let mut buf = [0u8; 256];
            if CFStringGetCString(v, buf.as_mut_ptr(), buf.len() as isize, UTF8) != 0 {
                let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
                out = Some(String::from_utf8_lossy(&buf[..end]).into_owned());
            }
        }
        CFRelease(v);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn css_forms() {
        let mut v = serde_json::Map::new();
        v.insert("a".into(), "13 17 23".into());
        v.insert("b".into(), "rgb(52 133 250)".into());
        v.insert("c".into(), "rgb(255 255 255 / 0.5)".into());
        v.insert("d".into(), "#e6edf3".into());
        assert_eq!(css(&v, "a", None), Some(Rgb(13, 17, 23)));
        assert_eq!(css(&v, "b", None), Some(Rgb(52, 133, 250)));
        assert_eq!(css(&v, "c", Some(Rgb(0, 0, 0))), Some(Rgb(128, 128, 128)));
        assert_eq!(css(&v, "d", None), Some(Rgb(0xe6, 0xed, 0xf3)));
    }

    #[test]
    fn one_dark_unchanged() {
        let t = one_dark(Rgb(0x28, 0x2c, 0x34));
        assert_eq!(t.panel, Rgb(0x28, 0x2c, 0x34).mix(Rgb(0xab, 0xb2, 0xbf), 0.055).c());
        assert!(!t.rex);
    }
}
