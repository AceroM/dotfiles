//! `al --snapshot WxH [--keys …]`: play keys, render one frame offscreen and
//! print it as plain text. Nothing is focused, closed or sent: what the agent
//! box would have sent goes to stderr.

use std::process::ExitCode;

use ratatui::backend::TestBackend;
use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;
use ratatui::Terminal;

use crate::app::{Act, App};
use crate::ui;

pub fn run(mut app: App, w: u16, h: u16, keys: &str) -> ExitCode {
    app.live = false;
    let area = Rect::new(0, 0, w, h);
    app.layout_for(area);
    app.prepare();
    for ev in parse_keys(keys) {
        if let Act::Quit = app.handle(ev) {
            break;
        }
        app.layout_for(area);
        app.prepare();
    }
    if let Some(t) = &app.sent {
        eprintln!("sent: {t}");
    }
    if let Some(t) = &app.copied {
        eprintln!("copied: {t}");
    }
    if let Some(t) = &app.opened {
        eprintln!("opened: {t}");
    }
    let mut term = match Terminal::new(TestBackend::new(w, h)) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("al: {e}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(e) = term.draw(|f| ui::draw(&app, f)) {
        eprintln!("al: {e}");
        return ExitCode::FAILURE;
    }
    let buf = term.backend().buffer();
    for y in 0..h {
        let row: String = (0..w).map(|x| buf[(x, y)].symbol().to_string()).collect();
        println!("{}", row.trim_end());
    }
    ExitCode::SUCCESS
}

/// `<P40,5>` press the left button at column 40, row 5 (0-based cells);
/// `D` drags there, `R` releases, `C` ctrl-clicks, `X` right-clicks, `W`/`w`
/// wheel up/down.
fn mouse_tok(t: &str) -> Option<Event> {
    let (kind, modifiers) = match t.as_bytes().first()? {
        b'P' => (MouseEventKind::Down(MouseButton::Left), KeyModifiers::NONE),
        b'D' => (MouseEventKind::Drag(MouseButton::Left), KeyModifiers::NONE),
        b'R' => (MouseEventKind::Up(MouseButton::Left), KeyModifiers::NONE),
        b'C' => (MouseEventKind::Down(MouseButton::Left), KeyModifiers::CONTROL),
        b'X' => (MouseEventKind::Down(MouseButton::Right), KeyModifiers::NONE),
        b'W' => (MouseEventKind::ScrollUp, KeyModifiers::NONE),
        b'w' => (MouseEventKind::ScrollDown, KeyModifiers::NONE),
        _ => return None,
    };
    let (x, y) = t[1..].split_once(',')?;
    Some(Event::Mouse(MouseEvent { kind, column: x.parse().ok()?, row: y.parse().ok()?, modifiers }))
}

/// `jjx<C-d><Tab><CR>` style key sequences, plus mouse tokens (`mouse_tok`)
/// and `<paste:text>`.
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
        if let Some(text) = tok.strip_prefix("paste:") {
            out.push(Event::Paste(text.to_string()));
            continue;
        }
        let (code, mods) = match tok.as_str() {
            "CR" | "Enter" => (KeyCode::Enter, KeyModifiers::NONE),
            "S-CR" => (KeyCode::Enter, KeyModifiers::SHIFT),
            "Esc" => (KeyCode::Esc, KeyModifiers::NONE),
            "Tab" => (KeyCode::Tab, KeyModifiers::NONE),
            "BS" => (KeyCode::Backspace, KeyModifiers::NONE),
            "Down" => (KeyCode::Down, KeyModifiers::NONE),
            "Up" => (KeyCode::Up, KeyModifiers::NONE),
            "Space" => (KeyCode::Char(' '), KeyModifiers::NONE),
            "lt" => (KeyCode::Char('<'), KeyModifiers::NONE),
            t if t.starts_with("C-") && t.len() == 3 => (KeyCode::Char(t.chars().nth(2).unwrap_or(' ')), KeyModifiers::CONTROL),
            _ => continue,
        };
        out.push(key(code, mods));
    }
    out
}
