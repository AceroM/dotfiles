mod agent;
mod ansi;
mod app;
mod drafts;
mod fuzzy;
mod gfx;
mod links;
mod rex;
mod select;
mod snapshot;
mod rex_theme;
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
use theme::Palette;

const HELP: &str = "\
al — this Rex session's tabs: the list on the left, the selected tab's pane on the right

usage:
  al                   switch to, read, reply to and close tabs, and keep drafts (? inside for keys)
  al -l, --list        print the tabs (id, status, name, title, folder), tab-separated

options:
  --cwd DIR            where `c` starts a new agent (default: this repo's root, else here)
  --path PATH          what ^i / tab puts in the agent box (jv passes the file it's on)
  -h, --help

Runs inside a Rex pane. Keys are jv's `;` dialog's: j/k (with counts), J/K scroll the
preview, x or ; closes, c asks a new agent, r replies to the tab's agent, ⏎ goes, / finds,
y / Y copy the tab's pane / session ID.
d starts a draft: it's on top of the tabs at once, its page open on the right, saved as you
type (in ~/.local/state/al, images and all). ⏎ sends it to a new agent; esc keeps it for
later, when ⏎ on it sends it. e writes in it again, x deletes it, u undoes. D drafts a
reply to the selected tab's agent the same way (⏎ sends it there), and ^s in the c or r
box turns what you've written into a draft, carried on on its page.
Its page draws its images (Kitty graphics, where the terminal speaks it). AL_IMAGES=0: off.
In a box, as in a text editor: ^a ^e the line's start / end, ^u ^k delete to them, ⌘↑ ⌘↓
(or fn↑ fn↓) the text's start / end, shift (⌥⇧ a word) with the arrows selects, ^c copies
the selection or else clears the input (^z brings it back; ^c on an empty box leaves), ^x cuts.
shift+tab in the c box (or on a new agent's draft) switches it between claude and codex;
^p in the c or r box (or on a draft) sends it as `/plan …`, so the agent plans first.
In the preview, as in Codex: drag (or double/triple-click) marks text and ^c copies it;
ctrl-click opens a link, a code location in Neovim in a floating Rex pane.
The agents are `claude --dangerously-skip-permissions` and `codex --no-daemon --yolo` (cx's
flags); $AL_AGENT (else $JV_AGENT) names the first one, e.g. AL_AGENT=\"codex --yolo\".
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
    if argv.get(1).map(String::as_str) == Some(agent::RUN_FLAG) {
        return agent::run_child(&argv[2..]);
    }
    if argv.get(1).map(String::as_str) == Some(agent::REPLY_FLAG) {
        return agent::reply_child(&argv[2..]);
    }
    let cli = match parse_cli() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("al: {e}");
            return ExitCode::from(2);
        }
    };
    if !agent::in_rex() {
        eprintln!("al: not inside a Rex pane (REX_SESSION isn't set)");
        return ExitCode::FAILURE;
    }
    if cli.list {
        return print_list();
    }
    let cwd = cli.cwd.or_else(repo_root).or_else(|| std::env::current_dir().ok()).unwrap_or_else(|| ".".into());
    let theme = rex_theme::theme(&["AL_BG", "JV_BG"]);
    let mut app = match App::new(Palette::new(&theme), Opts { cwd, path: cli.path }) {
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
    let ses = rex::session().unwrap_or_default();
    let me = std::env::var("REX_BLOCK").unwrap_or_default();
    match rex::tabs(&ses, &me) {
        Ok((_, tabs)) => {
            let clean = |s: &str| s.replace('\t', " ");
            for t in &tabs {
                println!("{}\t{}\t{}\t{}\t{}", t.id, t.status, clean(t.name()), clean(&t.title), rex::tilde(&t.cwd));
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
    // Before anything else reads input: the answer comes back on stdin.
    app.gfx = gfx::detect();
    let kitty = matches!(supports_keyboard_enhancement(), Ok(true));
    modes(true, kitty);
    std::thread::spawn(drafts::sweep);
    let res = event_loop(&mut terminal, app);
    let bye = app.clear_images();
    if !bye.is_empty() {
        let _ = terminal.backend_mut().write_all(&bye);
        let _ = terminal.backend_mut().flush();
    }
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
            // Images go out before the cells that show them.
            let g = app.take_gfx();
            if !g.is_empty() {
                terminal.backend_mut().write_all(&g)?;
                terminal.backend_mut().flush()?;
            }
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
/// (links.rs), so the terminal's ctrl-click opens a link the preview cuts off, and a
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
