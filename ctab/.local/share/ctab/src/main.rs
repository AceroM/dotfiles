mod app;
mod bridge;
mod fuzzy;
mod gfx;
mod theme;
mod ui;

use std::io::{self, Write};
use std::process::ExitCode;
use std::time::Duration;

use ratatui::backend::TestBackend;
use ratatui::crossterm::event::{self, DisableMouseCapture, EnableMouseCapture};
use ratatui::crossterm::execute;
use ratatui::layout::Rect;
use ratatui::{DefaultTerminal, Terminal};

use app::{Act, App};
use theme::{Palette, Rgb};

const HELP: &str = "\
ctab — your browser's tabs: the list on the left, the selected tab's screenshot on the right

usage:
  ctab                 switch, find and close tabs (? inside for keys)
  ctab -l, --list      print every tab (id, window, title, URL), tab-separated

options:
  --browser NAME       pick a connected browser when several are (also $BROWSER_USE_BROWSER)
  -h, --help

Talks to the browser-use extension (`browser-use status`). Keys are jv's `;` dialog's:
j/k (with counts), x or ; closes, ⏎ goes, / finds. The preview is the tab's screenshot.
";

fn main() -> ExitCode {
    let mut browser = std::env::var("BROWSER_USE_BROWSER").ok().filter(|s| !s.is_empty());
    let mut list = false;
    let mut snapshot: Option<(u16, u16)> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "-h" | "--help" => {
                print!("{HELP}");
                return ExitCode::SUCCESS;
            }
            "-l" | "--list" => list = true,
            "--browser" => browser = args.next(),
            // Hidden: render one frame as plain text, for UI work without a terminal.
            "--snapshot" => {
                snapshot = args.next().and_then(|v| {
                    let (w, h) = v.split_once('x')?;
                    Some((w.parse().ok()?, h.parse().ok()?))
                });
                if snapshot.is_none() {
                    eprintln!("ctab: --snapshot needs WxH");
                    return ExitCode::from(2);
                }
            }
            _ => {
                eprintln!("ctab: unknown argument {a} (ctab -h)");
                return ExitCode::from(2);
            }
        }
    }
    let host = match bridge::pick(browser.as_deref()) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("ctab: {e}");
            return ExitCode::FAILURE;
        }
    };
    if list {
        return print_list(&host);
    }
    let bg = ["CTAB_BG", "JV_BG"]
        .iter()
        .find_map(|k| std::env::var(k).ok().and_then(|s| Rgb::parse(&s)))
        .unwrap_or(Rgb(0x28, 0x2c, 0x34));
    let mut app = match App::new(host, Palette::new(bg)) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("ctab: {e}");
            return ExitCode::FAILURE;
        }
    };
    if let Some((w, h)) = snapshot {
        return render_snapshot(app, w, h);
    }
    match run(&mut app) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("ctab: {e}");
            ExitCode::FAILURE
        }
    }
}

fn print_list(host: &bridge::Host) -> ExitCode {
    match bridge::list(host) {
        Ok(s) => {
            for t in &s.tabs {
                let w = s.windows.iter().position(|w| w.id == t.window).map_or(0, |p| p + 1);
                println!("{}\t{w}\t{}\t{}", t.id, t.display_title().replace('\t', " "), t.url);
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("ctab: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(app: &mut App) -> io::Result<()> {
    let mut terminal = ratatui::init();
    // Before anything reads input: the answer comes back on stdin.
    app.gfx = gfx::detect();
    let _ = execute!(io::stdout(), EnableMouseCapture);
    let res = event_loop(&mut terminal, app);
    let bye = app.clear_images();
    if !bye.is_empty() {
        let _ = terminal.backend_mut().write_all(&bye);
        let _ = terminal.backend_mut().flush();
    }
    let _ = execute!(io::stdout(), DisableMouseCapture);
    ratatui::restore();
    res
}

fn event_loop(terminal: &mut DefaultTerminal, app: &mut App) -> io::Result<()> {
    let mut dirty = true;
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
            terminal.draw(|f| ui::draw(app, f))?;
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

fn render_snapshot(mut app: App, w: u16, h: u16) -> ExitCode {
    app.live = false;
    app.layout_for(Rect::new(0, 0, w, h));
    app.await_peek(Duration::from_secs(4));
    app.tick();
    app.prepare();
    let mut term = match Terminal::new(TestBackend::new(w, h)) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("ctab: {e}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(e) = term.draw(|f| ui::draw(&app, f)) {
        eprintln!("ctab: {e}");
        return ExitCode::FAILURE;
    }
    let buf = term.backend().buffer();
    for y in 0..h {
        let row: String = (0..w).map(|x| buf[(x, y)].symbol().to_string()).collect();
        println!("{}", row.trim_end());
    }
    ExitCode::SUCCESS
}
