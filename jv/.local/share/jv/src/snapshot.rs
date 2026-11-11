//! `jv --snapshot WxH [--keys …] [--out f.html]`: render one frame offscreen
//! and dump it as HTML with exact cell colors. Used to eyeball UI changes
//! (screenshot the HTML with headless Chrome) without a live terminal.

use std::process::ExitCode;
use std::time::Duration;

use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier};
use ratatui::Terminal;
use unicode_width::UnicodeWidthStr;

use crate::app::{Act, App};
use crate::theme::Palette;
use crate::ui;

pub fn run(mut app: App, w: u16, h: u16, keys: &str, out: Option<&str>) -> ExitCode {
    if let Some(rx) = app.meta_rx.take() {
        if let Ok(m) = rx.recv_timeout(Duration::from_secs(10)) {
            app.meta = Some(m);
        }
    }
    // Copies land in app.copied (printed to stderr), not the clipboard, and
    // the c box starts no agent.
    app.live = false;
    let area = Rect::new(0, 0, w, h);
    app.layout_for(area);
    // jp: each key waits for the PR it lands on, so the frame shows a diff.
    app.settle();
    for ev in parse_keys(keys) {
        if let Act::Quit = app.handle(ev) {
            break;
        }
        app.layout_for(area);
        app.settle();
    }
    if let Some(t) = &app.copied {
        eprintln!("{t}");
    }
    app.msg = None;
    app.prepare();
    let mut term = match Terminal::new(TestBackend::new(w, h)) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("jv: {e}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(e) = term.draw(|f| ui::draw(&app, f)) {
        eprintln!("jv: {e}");
        return ExitCode::FAILURE;
    }
    let html = to_html(term.backend().buffer(), &app.pal);
    match out {
        Some(path) => {
            if let Err(e) = std::fs::write(path, html) {
                eprintln!("jv: writing {path}: {e}");
                return ExitCode::FAILURE;
            }
        }
        None => print!("{html}"),
    }
    ExitCode::SUCCESS
}

/// `<P40,5>` press, `<D60,8>` drag, `<U60,8>` release the left button at
/// column 40, row 5 (0-based screen cells).
fn mouse_tok(t: &str) -> Option<Event> {
    let kind = match t.as_bytes().first()? {
        b'P' => MouseEventKind::Down(MouseButton::Left),
        b'D' => MouseEventKind::Drag(MouseButton::Left),
        b'U' => MouseEventKind::Up(MouseButton::Left),
        _ => return None,
    };
    let (x, y) = t[1..].split_once(',')?;
    Some(Event::Mouse(MouseEvent { kind, column: x.parse().ok()?, row: y.parse().ok()?, modifiers: KeyModifiers::NONE }))
}

/// `jjs<C-d><Tab><CR>` style key sequences, plus mouse tokens (`mouse_tok`).
fn parse_keys(s: &str) -> Vec<Event> {
    let key = |code, mods| Event::Key(KeyEvent::new(code, mods));
    let mut out = Vec::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '<' {
            let mods = if c.is_uppercase() { KeyModifiers::SHIFT } else { KeyModifiers::NONE };
            out.push(key(KeyCode::Char(c), mods));
            continue;
        }
        let tok: String = chars.by_ref().take_while(|&d| d != '>').collect();
        if let Some(ev) = mouse_tok(&tok) {
            out.push(ev);
            continue;
        }
        let (code, mods) = match tok.as_str() {
            "CR" | "Enter" => (KeyCode::Enter, KeyModifiers::NONE),
            "Esc" => (KeyCode::Esc, KeyModifiers::NONE),
            "Tab" => (KeyCode::Tab, KeyModifiers::NONE),
            "BS" => (KeyCode::Backspace, KeyModifiers::NONE),
            "Down" => (KeyCode::Down, KeyModifiers::NONE),
            "Up" => (KeyCode::Up, KeyModifiers::NONE),
            "Left" => (KeyCode::Left, KeyModifiers::NONE),
            "Right" => (KeyCode::Right, KeyModifiers::NONE),
            "M-CR" => (KeyCode::Enter, KeyModifiers::ALT),
            "M-Left" => (KeyCode::Left, KeyModifiers::ALT),
            "M-Right" => (KeyCode::Right, KeyModifiers::ALT),
            t if t.starts_with("M-") && t.len() == 3 => (KeyCode::Char(t.chars().nth(2).unwrap_or(' ')), KeyModifiers::ALT),
            "Space" => (KeyCode::Char(' '), KeyModifiers::NONE),
            "lt" => (KeyCode::Char('<'), KeyModifiers::NONE),
            t if t.starts_with("C-") && t.len() == 3 => {
                (KeyCode::Char(t.chars().nth(2).unwrap_or(' ')), KeyModifiers::CONTROL)
            }
            _ => continue,
        };
        out.push(key(code, mods));
    }
    out
}

fn hex(c: Color, default: &str) -> String {
    match c {
        Color::Rgb(r, g, b) => format!("#{r:02x}{g:02x}{b:02x}"),
        Color::Reset => default.to_string(),
        Color::Black => "#282c34".into(),
        Color::Red => "#e06c75".into(),
        Color::Green => "#98c379".into(),
        Color::Yellow => "#e5c07b".into(),
        Color::Blue => "#61afef".into(),
        Color::Magenta => "#c678dd".into(),
        Color::Cyan => "#56b6c2".into(),
        Color::Gray | Color::White => "#abb2bf".into(),
        Color::DarkGray => "#636d83".into(),
        _ => default.to_string(),
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn to_html(buf: &Buffer, pal: &Palette) -> String {
    let bg = format!("#{:02x}{:02x}{:02x}", pal.bg.0, pal.bg.1, pal.bg.2);
    let fg = "#abb2bf";
    let mut s = format!(
        "<!doctype html><meta charset=utf-8><style>body{{margin:0;background:{bg}}}\
         pre{{margin:0;padding:10px;font:13px/18px 'JetBrains Mono','SF Mono',Menlo,monospace;color:{fg}}}\
         span{{white-space:pre;display:inline-block;height:18px;vertical-align:top}}</style><pre>"
    );
    let area = buf.area;
    for y in 0..area.height {
        let mut x = 0;
        let mut cur: Option<(String, String, Modifier)> = None;
        let mut text = String::new();
        let flush = |s: &mut String, cur: &Option<(String, String, Modifier)>, text: &mut String| {
            if text.is_empty() {
                return;
            }
            if let Some((f, b, m)) = cur {
                let mut style = format!("color:{f};background:{b}");
                if m.contains(Modifier::BOLD) {
                    style.push_str(";font-weight:bold");
                }
                if m.contains(Modifier::ITALIC) {
                    style.push_str(";font-style:italic");
                }
                s.push_str(&format!("<span style=\"{style}\">{}</span>", esc(text)));
            }
            text.clear();
        };
        while x < area.width {
            let c = &buf[(x, y)];
            let sym = c.symbol();
            let key = (hex(c.fg, fg), hex(c.bg, &bg), c.modifier);
            if cur.as_ref() != Some(&key) {
                flush(&mut s, &cur, &mut text);
                cur = Some(key);
            }
            text.push_str(if sym.is_empty() { " " } else { sym });
            x += sym.width().max(1) as u16;
        }
        flush(&mut s, &cur, &mut text);
        s.push('\n');
    }
    s.push_str("</pre>");
    s
}
