mod agent;
mod ansi;
mod app;
mod fuzzy;
mod herdr;
mod links;
mod select;
mod snapshot;
mod theme;
mod transcript;
mod ui;

use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

use ratatui::crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture, KeyboardEnhancementFlags,
    PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use ratatui::backend::IntoCrossterm;
use ratatui::buffer::Buffer;
use ratatui::crossterm::cursor::MoveTo;
use ratatui::crossterm::style::{Print, PrintStyledContent};
use ratatui::crossterm::terminal::supports_keyboard_enhancement;
use ratatui::crossterm::{execute, queue};
use ratatui::layout::{Rect, Size};
use ratatui::style::Style;
use ratatui::DefaultTerminal;
use unicode_width::UnicodeWidthStr;

use app::{Act, App, Opts};
use theme::{Palette, Rgb};

const HELP: &str = "\
al — this Herdr space's tabs: the list on the left, the selected tab's pane on the right

usage:
  al                   switch to, read, reply to and close tabs (? inside for keys)
  al -l, --list        print the tabs (id, status, name, title, folder), tab-separated

options:
  --cwd DIR            where `c` starts a new agent (default: this repo's root, else here)
  --path PATH          what ^i / tab puts in the agent box (jv passes the file it's on)
  -h, --help

Runs inside a Herdr pane. Keys are jv's `;` dialog's: j/k (with counts), d/u scroll the
preview, x or ; closes, c asks a new agent, r replies to the tab's agent, ⏎ goes, / finds.
In the preview, as in Codex: drag (or double/triple-click) marks text and ^c copies it;
ctrl-click opens a link, a code location in Neovim in a Herdr popup.
The agent is `claude --dangerously-skip-permissions` unless $AL_AGENT (else $JV_AGENT)
names another, e.g. AL_AGENT=\"codex --yolo\".
";

struct Cli {
    list: bool,
    cwd: Option<PathBuf>,
    path: Option<String>,
    snapshot: Option<(u16, u16)>,
    keys: String,
}

fn parse_cli() -> Result<Cli, String> {
    let mut c = Cli { list: false, cwd: None, path: None, snapshot: None, keys: String::new() };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "-h" | "--help" => {
                print!("{HELP}");
                std::process::exit(0);
            }
            "-l" | "--list" => c.list = true,
            "--cwd" => c.cwd = Some(args.next().ok_or("--cwd needs a folder")?.into()),
            "--path" => c.path = Some(args.next().ok_or("--path needs a path")?).filter(|p| !p.is_empty()),
            // Hidden: render one frame as plain text after --keys, for UI work
            // without a terminal. Nothing is focused, closed or sent.
            "--snapshot" => {
                let v = args.next().ok_or("--snapshot needs WxH")?;
                let (w, h) = v.split_once('x').ok_or("--snapshot needs WxH")?;
                c.snapshot = Some((w.parse().map_err(|_| "bad width")?, h.parse().map_err(|_| "bad height")?));
            }
            "--keys" => c.keys = args.next().ok_or("--keys needs keys")?,
            _ => return Err(format!("unknown argument {a} (al -h)")),
        }
    }
    Ok(c)
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();
    if argv.get(1).map(String::as_str) == Some(agent::CHILD_FLAG) {
        return agent::child(&argv[2..]);
    }
    let cli = match parse_cli() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("al: {e}");
            return ExitCode::from(2);
        }
    };
    if !agent::in_herdr() {
        eprintln!("al: not inside a Herdr pane (HERDR_ENV isn't 1)");
        return ExitCode::FAILURE;
    }
    if cli.list {
        return print_list();
    }
    let cwd = cli.cwd.or_else(repo_root).or_else(|| std::env::current_dir().ok()).unwrap_or_else(|| ".".into());
    let bg = ["AL_BG", "JV_BG"]
        .iter()
        .find_map(|k| std::env::var(k).ok().and_then(|s| Rgb::parse(&s)))
        .unwrap_or(Rgb(0x28, 0x2c, 0x34));
    let mut app = match App::new(Palette::new(bg), Opts { cwd, path: cli.path }) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("al: {e}");
            return ExitCode::FAILURE;
        }
    };
    if let Some((w, h)) = cli.snapshot {
        return snapshot::run(app, w, h, &cli.keys);
    }
    match run(&mut app) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("al: {e}");
            ExitCode::FAILURE
        }
    }
}

/// The git repo around the current folder.
fn repo_root() -> Option<PathBuf> {
    let out = Command::new("git").args(["rev-parse", "--show-toplevel"]).stderr(Stdio::null()).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !s.is_empty()).then(|| s.into())
}

fn print_list() -> ExitCode {
    let ws = std::env::var("HERDR_WORKSPACE_ID").unwrap_or_default();
    let me = std::env::var("HERDR_TAB_ID").unwrap_or_default();
    match herdr::tabs(&ws, &me) {
        Ok((_, tabs)) => {
            let clean = |s: &str| s.replace('\t', " ");
            for t in &tabs {
                println!("{}\t{}\t{}\t{}\t{}", t.id, t.status, clean(t.name()), clean(&t.title), herdr::tilde(&t.cwd));
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("al: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(app: &mut App) -> io::Result<()> {
    let mut terminal = ratatui::init();
    let kitty = matches!(supports_keyboard_enhancement(), Ok(true));
    modes(true, kitty);
    let res = event_loop(&mut terminal, app);
    modes(false, kitty);
    ratatui::restore();
    res
}

/// The terminal modes al adds to ratatui's, as jv does: mouse reports,
/// bracketed paste (a pasted newline mustn't send the agent box), and where
/// the terminal has it, the kitty keyboard protocol's first level, so
/// shift+Enter and ^i arrive as themselves instead of as Enter and Tab.
fn modes(on: bool, kitty: bool) {
    let mut out = io::stdout();
    if on {
        let _ = execute!(out, EnableMouseCapture, EnableBracketedPaste);
        if kitty {
            let _ = execute!(out, PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES));
        }
    } else {
        if kitty {
            let _ = execute!(out, PopKeyboardEnhancementFlags);
        }
        let _ = execute!(out, DisableMouseCapture, DisableBracketedPaste);
    }
}

fn event_loop(terminal: &mut DefaultTerminal, app: &mut App) -> io::Result<()> {
    let mut dirty = true;
    let (mut drawn, mut size) = (Vec::new(), Size::default());
    loop {
        let s = terminal.size()?;
        app.layout_for(Rect::new(0, 0, s.width, s.height));
        dirty |= app.tick();
        if dirty {
            app.prepare();
            let frame = terminal.draw(|f| ui::draw(app, f))?;
            // A resize redraws everything, their links gone with it.
            if s != size {
                (drawn, size) = (Vec::new(), s);
            }
            hyperlinks(app, frame.buffer, &mut drawn)?;
            dirty = false;
        }
        if !event::poll(Duration::from_millis(100))? {
            continue;
        }
        // Drain everything queued (a held j, fast wheel scrolling) before redrawing.
        loop {
            if let Act::Quit = app.handle(event::read()?) {
                return Ok(());
            }
            dirty = true;
            if !event::poll(Duration::ZERO)? {
                break;
            }
        }
    }
}

/// A link as written: where, its target, and the cells it was written over.
#[derive(PartialEq)]
struct Hyperlink {
    x: u16,
    y: u16,
    uri: String,
    cells: Vec<(String, Style)>,
}

/// The preview's links as OSC 8 hyperlinks, each carrying its whole target
/// (links.rs), so Herdr's ctrl-click opens a link the preview cuts off, and a
/// path in the previewed tab's folder. Ratatui can't write them, so they go
/// over its frame: each link's cells again, inside the hyperlink, wherever
/// they changed since `drawn` (ratatui rewriting a cell drops its link).
fn hyperlinks(app: &App, buf: &Buffer, drawn: &mut Vec<Hyperlink>) -> io::Result<()> {
    let mut out = io::stdout().lock();
    let mut now = Vec::new();
    for (x, y, w, uri) in app.link_runs() {
        let cells = (x..x + w).map(|cx| (buf[(cx, y)].symbol().to_string(), buf[(cx, y)].style())).collect();
        let link = Hyperlink { x, y, uri, cells };
        if !drawn.contains(&link) {
            queue!(out, MoveTo(x, y), Print(format!("\x1b]8;;{}\x1b\\", link.uri)))?;
            let mut skip = 0;
            for (sym, st) in &link.cells {
                // The cells behind a wide character are its own.
                if skip > 0 {
                    skip -= 1;
                    continue;
                }
                skip = sym.width().saturating_sub(1);
                queue!(out, PrintStyledContent((*st).into_crossterm().apply(sym.as_str())))?;
            }
            queue!(out, Print("\x1b]8;;\x1b\\"))?;
        }
        now.push(link);
    }
    out.flush()?;
    *drawn = now;
    Ok(())
}
