mod app;
mod config;
mod drafts;
mod field;
mod gfx;
mod probe;
mod spawn;
mod term;
mod rex_theme;
mod theme;
mod ui;

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use ratatui::crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::crossterm::terminal;

use app::{Act, App, Opts};
use term::Inline;
use theme::Palette;

const HELP: &str = "\
o — a `claude(opus) >` prompt made to type into fast: ⏎ starts that agent with it in a
new Rex tab, and the prompt empties for the next one. Drawn in place, writing only the
cells a key changes; each send is printed above it.

usage:
  o                    write a prompt
  o NOTE               start from a note: its path and contents, the tab named after it
  o TEXT…              start from TEXT
  o -d, --drafts       start in the drafts list
  o --config           the configurations, and the keys to them
  --cwd DIR            where the agents start (default: here)
  -h, --help

Runs inside a Rex terminal (oc is the same prompt for Herdr). The keys:
  ⏎ sends (to a new tab, in the background) · ^⏎ or ^o sends and goes to the tab
  ⇧⏎ ⌥⏎ ^j newline · ^p plan mode (sends `/plan …`)
  ↑ on an empty prompt selects a created session · ↑ ↓ choose · ⏎ focus · esc compose
  ⇧tab the next configuration (round to the first) · ^1 … ^9 the Nth
  ^v pastes the clipboard's image (⌘V too, with only an image on it); a file dragged
  in from Finder is attached. Either is an [Image #N] tag, its file listed at the end
  of what's sent (not drawn).
  The mouse is the terminal's (its own selecting and scrolling); O_MOUSE=1 gives it
  to o: a click puts the cursor there, a drag selects, the wheel scrolls a long prompt.
  Before `>` is the configuration ⏎ starts; yellow is plan mode.
  As in a shell: ^l clears the screen (the prompt kept), ↑ on the first row goes back
  through what was sent (↓ forward again), ^a ^e the line's start / end, ^u ^k ^w ⌥d
  delete (^y puts it back), ^b ^f ^h ^d ^t, ⌥← ⌥→ by word; ⌘↑ ⌘↓ (fn↑ fn↓) the text's
  ends; shift (⌥⇧ a word) with the arrows selects
  ^c copies the selection, else clears the prompt (^z brings it back, or what ⏎ sent);
  esc esc clears it too; ^c, ^d or esc on an empty prompt quits
  When an agent exits, its tab is left at a shell in the agent's folder.
Drafts (o's own, per Rex session, in ~/.local/state/o/drafts.json):
  ^s keeps the prompt as a draft, saved as you type from then on (the prompt reads ◇);
  esc leaves it for later, ⏎ sends it (from the folder it was written in) and it goes
  ^g goes through this session's drafts: j k move · ⏎ sends (^⏎ ^o and goes there) ·
  e (l, r) edits · x ; deletes · u brings it back · d a new one · esc back to the prompt.
  The selected draft's images show over the list, small (Kitty graphics; O_IMAGES=0 off).
  ⇧↑ ⇧↓ (J K) mark drafts as they go, space marks one, a all (again: none); with some
  marked, ⏎ sends them as ONE prompt to one new agent: a preamble, then each draft as
  a task (images numbered across them), from the first one's folder on its configuration
  (plan mode if any is); x deletes them all (u brings them back); esc unmarks.
Configurations: ~/.config/o/config.toml lists them, in order, as [[agent]] tables:
  kind = \"claude\"     the command (claude, codex)
  model = \"fable\"     passed as --model fable; shown as claude(fable)
  args = [\"…\"]        the agent's own arguments
  name = \"…\"          shown instead of kind(model)
Without the file: claude(opus) and claude(fable) (--dangerously-skip-permissions), then
codex (--no-daemon --yolo). o starts on the one picked last (kept in
~/.local/state/o/last-agent), else the first; $O_AGENT names one instead
(O_AGENT=codex).
";

struct Cli {
    cwd: Option<PathBuf>,
    words: Vec<String>,
    snapshot: Option<(u16, u16)>,
    /// --snapshot as if the terminal drew images, cells this many pixels.
    cell: Option<(u16, u16)>,
    keys: String,
    drafts: bool,
    config: bool,
}

fn parse_cli() -> Result<Cli, String> {
    let mut c = Cli { cwd: None, words: Vec::new(), snapshot: None, cell: None, keys: String::new(), drafts: false, config: false };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "-h" | "--help" => {
                print!("{HELP}");
                std::process::exit(0);
            }
            "-d" | "--drafts" => c.drafts = true,
            "--config" => c.config = true,
            "--cwd" => c.cwd = Some(args.next().ok_or("--cwd needs a folder")?.into()),
            // Hidden: render one frame as plain text after --keys, for UI work
            // without a terminal. Nothing is sent.
            "--snapshot" => {
                let v = args.next().ok_or("--snapshot needs WxH")?;
                let (w, h) = v.split_once('x').ok_or("--snapshot needs WxH")?;
                c.snapshot = Some((w.parse().map_err(|_| "bad width")?, h.parse().map_err(|_| "bad height")?));
            }
            "--keys" => c.keys = args.next().ok_or("--keys needs keys")?,
            "--cell" => {
                let v = args.next().ok_or("--cell needs WxH")?;
                let (w, h) = v.split_once('x').ok_or("--cell needs WxH")?;
                c.cell = Some((w.parse().map_err(|_| "bad width")?, h.parse().map_err(|_| "bad height")?));
            }
            "--" => c.words.extend(args.by_ref()),
            s if s.starts_with('-') && s.len() > 1 => return Err(format!("unknown option {s} (o -h)")),
            _ => c.words.push(a),
        }
    }
    Ok(c)
}

/// A note's tab label, as the shell's `_h_slug`: lowercase, runs of anything
/// but [a-z0-9] one `_`, none at the ends, at most 28 characters.
fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    let out = out.trim_matches('_');
    out.chars().take(28).collect::<String>().trim_end_matches('_').to_string()
}

/// What the box starts with, and the first tab's label: a note's path and
/// contents (and its name), or the words as they are.
fn start_text(words: &[String]) -> Result<(String, String), String> {
    if let [one] = words {
        let path = Path::new(one);
        if path.is_file() {
            let abs = std::fs::canonicalize(path).map_err(|e| format!("{one}: {e}"))?;
            let body = std::fs::read_to_string(&abs).map_err(|e| format!("{one}: {e}"))?;
            let label = slug(&abs.file_stem().unwrap_or_default().to_string_lossy());
            return Ok((format!("Source Obsidian note: {}\n\n{}", abs.display(), body.trim_end()), label));
        }
    }
    Ok((words.join(" "), String::new()))
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();
    if argv.get(1).map(String::as_str) == Some(spawn::CHILD_FLAG) {
        return spawn::child(&argv[2..]);
    }
    let cli = match parse_cli() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("o: {e}");
            return ExitCode::from(2);
        }
    };
    let (agents, notice) = config::load();
    if cli.config {
        return show_config(&agents, notice.as_deref());
    }
    let (text, label) = match start_text(&cli.words) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("o: {e}");
            return ExitCode::FAILURE;
        }
    };
    let cwd = cli.cwd.or_else(|| std::env::current_dir().ok()).unwrap_or_else(|| ".".into());
    let cwd = std::fs::canonicalize(&cwd).unwrap_or(cwd);
    let theme = rex_theme::theme(&["O_BG", "AL_BG", "JV_BG"]);
    let (start, _) = config::start(&agents);
    let mut app = App::new(Palette::new(&theme), Opts { cwd, text, label, agents, start, notice });
    if let Some((w, h)) = cli.snapshot {
        app.gfx = cli.cell.map(|(cell_w, cell_h)| gfx::Gfx { cell_w, cell_h });
        return snapshot(app, w, h, &cli.keys);
    }
    if !spawn::in_rex() {
        eprintln!("o: not inside a Rex terminal (REX_SESSION isn't set)");
        return ExitCode::FAILURE;
    }
    std::thread::spawn(drafts::sweep);
    if cli.drafts {
        app.start_in_list();
    }
    match run(&mut app) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("o: {e}");
            ExitCode::FAILURE
        }
    }
}

/// `o --config`: where the configurations come from, and each one's key,
/// name and command.
fn show_config(agents: &[config::Agent], notice: Option<&str>) -> ExitCode {
    let path = config::shorten(&config::file());
    match notice {
        Some(e) => println!("{e}\n"),
        None if config::file().is_file() => println!("{path}\n"),
        None => println!("{path} isn't there: the defaults\n"),
    }
    let (start, why) = config::start(agents);
    let why = match why {
        config::Why::Env => " ($O_AGENT)",
        config::Why::Last => " (picked last)",
        config::Why::First => "",
    };
    let w = agents.iter().map(|a| unicode_width::UnicodeWidthStr::width(a.name.as_str())).max().unwrap_or(0);
    for (i, a) in agents.iter().enumerate() {
        let key = if i < 9 { format!("^{}", i + 1) } else { "  ".into() };
        let first = if i == start { format!(" ← o starts here{why}") } else { String::new() };
        let pad = w - unicode_width::UnicodeWidthStr::width(a.name.as_str());
        println!("  {key}  {}{}  {}{first}", a.name, " ".repeat(pad), a.command());
    }
    println!("\n⇧tab goes to the next one.");
    if notice.is_some() {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn run(app: &mut App) -> io::Result<()> {
    terminal::enable_raw_mode()?;
    restore_on_panic();
    // Before anything else reads input: the answers come back on stdin.
    let probe = probe::probe();
    app.gfx = probe.gfx;
    let mouse = std::env::var("O_MOUSE").is_ok_and(|v| matches!(v.as_str(), "1" | "on" | "yes" | "true"));
    modes(true, probe.kitty_keys, mouse);
    let (w, h) = terminal::size().unwrap_or((80, 24));
    let cursor = probe.cursor.or_else(|| ratatui::crossterm::cursor::position().ok()).unwrap_or((0, 0));
    let mut term = Inline::new(w, h, cursor);
    let res = event_loop(app, &mut term);
    app.flush();
    let mut s = Vec::new();
    term.clear(&mut s);
    s.extend(app.clear_images());
    let mut out = io::stdout();
    let _ = out.write_all(&s);
    let _ = out.flush();
    modes(false, probe.kitty_keys, mouse);
    let _ = terminal::disable_raw_mode();
    res
}

/// A panic leaves the terminal as it found it, then says what happened.
fn restore_on_panic() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        modes(false, true, true);
        let mut out = io::stdout();
        let _ = out.write_all(b"\x1b[0m\x1b[?25h\r\n");
        let _ = out.flush();
        let _ = terminal::disable_raw_mode();
        prev(info);
    }));
}

/// The terminal modes o turns on: bracketed paste (a pasted newline
/// mustn't send the prompt); where the terminal has it, the kitty keyboard
/// protocol's first level, so shift+Enter and ^⏎ arrive as themselves
/// instead of as Enter; and with O_MOUSE=1, mouse buttons and drags (not
/// motion: every move would be an event to read).
fn modes(on: bool, kitty: bool, mouse: bool) {
    let mut s: Vec<u8> = Vec::new();
    if on {
        s.extend_from_slice(b"\x1b[?2004h");
        if mouse {
            s.extend_from_slice(b"\x1b[?1000h\x1b[?1002h\x1b[?1006h");
        }
        if kitty {
            s.extend_from_slice(b"\x1b[>1u");
        }
    } else {
        if kitty {
            s.extend_from_slice(b"\x1b[<1u");
        }
        if mouse {
            s.extend_from_slice(b"\x1b[?1006l\x1b[?1002l\x1b[?1000l");
        }
        s.extend_from_slice(b"\x1b[?2004l");
    }
    let mut out = io::stdout();
    let _ = out.write_all(&s);
    let _ = out.flush();
}

fn event_loop(app: &mut App, term: &mut Inline) -> io::Result<()> {
    let mut out = io::stdout();
    let mut dirty = true;
    loop {
        dirty |= app.tick();
        let done = app.take_done();
        if dirty || !done.is_empty() {
            // What started printed above (the prompt drawn again under it,
            // all landing at once), then only what changed in the prompt:
            // for a key typed, its character.
            let mut s = Vec::new();
            let printed = !done.is_empty();
            if printed {
                s.extend_from_slice(b"\x1b[?2026h");
            }
            for n in done {
                let b = ui::entry(app, &app.sent[n], term.width);
                term.print_above(&mut s, &b);
            }
            app.layout(term.width, term.rows);
            // Images the frame draws go to the terminal first.
            s.extend(app.take_gfx());
            term.draw(&mut s, &ui::draw(app), app.cursor_cell());
            if printed {
                s.extend_from_slice(b"\x1b[?2026l");
            }
            if !s.is_empty() {
                out.write_all(&s)?;
                out.flush()?;
            }
            dirty = false;
        }
        // Keys wake it at once; the wait only paces what changes on its own.
        if !event::poll(app.wait())? {
            dirty |= app.idle();
            continue;
        }
        // Drain everything queued (a paste's worth of keys, fast scrolling) before redrawing.
        loop {
            match event::read()? {
                Event::Resize(w, h) => {
                    let mut s = Vec::new();
                    term.resize(&mut s, w, h);
                    out.write_all(&s)?;
                }
                // Rows counted from the prompt's first line. Above it is
                // the scrollback: only a drag from the prompt reaches there.
                Event::Mouse(mut m) => {
                    if m.row < term.top && !matches!(m.kind, MouseEventKind::Drag(_) | MouseEventKind::Up(_)) {
                        continue;
                    }
                    m.row = m.row.saturating_sub(term.top);
                    app.handle(Event::Mouse(m));
                }
                ev => match app.handle(ev) {
                    Act::Quit => return Ok(()),
                    Act::ClearScreen => {
                        let mut s = Vec::new();
                        term.clear_screen(&mut s);
                        out.write_all(&s)?;
                    }
                    Act::None => {}
                },
            }
            dirty = true;
            if !event::poll(Duration::ZERO)? {
                break;
            }
        }
    }
}

// ---- --snapshot --------------------------------------------------------------

/// `o --snapshot WxH [--keys …]`: play keys on a WxH terminal, then print
/// what o would have printed above the prompt and the prompt itself, as
/// plain text. Nothing is sent: a send counts as started, and what it would
/// have sent goes to stderr, with where the terminal's cursor would be.
fn snapshot(mut app: App, w: u16, h: u16, keys: &str) -> ExitCode {
    app.live = false;
    app.layout(w, h);
    let mut above = Vec::new();
    for ev in parse_keys(keys) {
        match app.handle(ev) {
            Act::Quit => {
                eprintln!("quit");
                break;
            }
            Act::ClearScreen => above.clear(),
            Act::None => {}
        }
        app.tick();
        for n in app.take_done() {
            let b = ui::entry(&app, &app.sent[n], w);
            above.extend((0..b.area.height).map(|y| term::plain(&b, y)));
        }
        app.layout(w, h);
    }
    if let Some(t) = &app.would_send {
        eprintln!("sent: {t:?}");
    }
    if let Some(t) = &app.would_copy {
        eprintln!("copied: {t:?}");
    }
    if let Some((x, y)) = app.cursor_cell() {
        eprintln!("cursor: {x},{y}");
    }
    let b = ui::draw(&app);
    for line in above.into_iter().chain((0..b.area.height).map(|y| term::plain(&b, y))) {
        println!("{line}");
    }
    ExitCode::SUCCESS
}

/// `<P40,5>` press the left button at column 40, row 5 (0-based cells,
/// rows from the prompt's first line);
/// `D` drags there, `R` releases, `W`/`w` wheel up/down.
fn mouse_tok(t: &str) -> Option<Event> {
    let kind = match t.as_bytes().first()? {
        b'P' => MouseEventKind::Down(MouseButton::Left),
        b'D' => MouseEventKind::Drag(MouseButton::Left),
        b'R' => MouseEventKind::Up(MouseButton::Left),
        b'W' => MouseEventKind::ScrollUp,
        b'w' => MouseEventKind::ScrollDown,
        _ => return None,
    };
    let (x, y) = t[1..].split_once(',')?;
    Some(Event::Mouse(MouseEvent { kind, column: x.parse().ok()?, row: y.parse().ok()?, modifiers: KeyModifiers::NONE }))
}

/// `abc<S-CR><C-p><BackTab>` style key sequences (modifiers stack:
/// `<M-S-Left>`), plus mouse tokens (`mouse_tok`) and `<paste:text>`.
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
            out.push(Event::Paste(text.replace("\\n", "\n")));
            continue;
        }
        // Modifiers first, vim's way: C- ctrl, M- alt, S- shift, D- super (⌘).
        let (mut name, mut mods) = (tok.as_str(), KeyModifiers::NONE);
        while name.len() > 2 && name.as_bytes()[1] == b'-' {
            mods |= match name.as_bytes()[0] {
                b'C' => KeyModifiers::CONTROL,
                b'M' => KeyModifiers::ALT,
                b'S' => KeyModifiers::SHIFT,
                b'D' => KeyModifiers::SUPER,
                _ => break,
            };
            name = &name[2..];
        }
        let code = match name {
            "CR" | "Enter" => KeyCode::Enter,
            "Esc" => KeyCode::Esc,
            "Tab" => KeyCode::Tab,
            "BackTab" => KeyCode::BackTab,
            "PgUp" => KeyCode::PageUp,
            "PgDn" => KeyCode::PageDown,
            "BS" => KeyCode::Backspace,
            "Del" => KeyCode::Delete,
            "Down" => KeyCode::Down,
            "Up" => KeyCode::Up,
            "Left" => KeyCode::Left,
            "Right" => KeyCode::Right,
            "Home" => KeyCode::Home,
            "End" => KeyCode::End,
            "Space" => KeyCode::Char(' '),
            "lt" => KeyCode::Char('<'),
            n if n.chars().count() == 1 && mods != KeyModifiers::NONE => KeyCode::Char(n.chars().next().unwrap_or(' ')),
            _ => continue,
        };
        out.push(key(code, mods));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_like_the_shell() {
        assert_eq!(slug("Fix Header (mobile)"), "fix_header_mobile");
        assert_eq!(slug("__a--b__"), "a_b");
        assert_eq!(slug("a very long note name that goes on and on"), "a_very_long_note_name_that_g");
    }
}
