mod agent;
mod app;
mod commit;
mod diff;
mod doc;
mod edit;
mod fuzzy;
mod highlight;
mod prs;
mod snapshot;
mod source;
mod theme;
mod tree;
mod ui;
mod viewed;

use std::io::{self, IsTerminal};
use std::process::{Command, ExitCode};
use std::time::Duration;

use ratatui::crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::supports_keyboard_enhancement;
use ratatui::layout::Rect;
use ratatui::DefaultTerminal;

use app::{Act, App, Opts};
use source::Source;
use theme::{Palette, Rgb};
use viewed::Viewed;

const HELP: &str = "\
jv — review a PR diff: file tree on the left, syntax-highlighted hunks on the right

usage:
  jv [PR | URL | BRANCH] [gh pr diff flags]   a PR (current branch's when omitted)
  jv . | -l                                    local changes (git diff HEAD)
  jv -g [git diff args]                        `git diff …`: everything after -g goes to git
                                               (jv -g --staged, jv -g main..., jv -g HEAD~3 -- src)
  jv -c 'git diff main...'                     any command that prints a diff
  git diff | jv                                a diff on stdin
  jv --prs [search terms]                      your recent PRs beside the diff (`jp`; jp -h)

options:
  -s, --split        start in split view (default: split when the pane is wide)
  -u, --unified      start in unified view
      --no-wrap      don't wrap long lines (h/l scroll sideways)
      --tests        show test files (hidden by default for PRs)
      --no-tests     hide test files (__tests__/, *.test.*, *.spec.*)
      --theme NAME   syntax theme (default TwoDark; also $JV_THEME)
      --themes       list syntax themes
      --popup        Esc quits once it has nothing left to clear; E leaves for its tab
  -h, --help

Inside jv, press ? for keys. With no PR on the current branch, jv shows
local changes instead.
";

struct Cli {
    gh: Vec<String>,
    split: Option<bool>,
    wrap: bool,
    tests: Option<bool>,
    theme: String,
    cmd: Option<String>,
    local: bool,
    git: Option<Vec<String>>,
    popup: bool,
    snapshot: Option<(u16, u16)>,
    keys: String,
    out: Option<String>,
    /// `--prs` (jp): the PR list on the left; `gh` holds its search words.
    prs: bool,
}

fn parse_cli() -> Result<Cli, String> {
    let mut c = Cli {
        gh: Vec::new(),
        split: None,
        wrap: true,
        tests: None,
        theme: std::env::var("JV_THEME").unwrap_or_else(|_| highlight::DEFAULT_THEME.to_string()),
        cmd: None,
        local: false,
        git: None,
        popup: false,
        snapshot: None,
        keys: String::new(),
        out: None,
        prs: false,
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "-h" | "--help" => {
                print!("{}", if c.prs { prs::HELP } else { HELP });
                std::process::exit(0);
            }
            "--prs" => c.prs = true,
            "--themes" => {
                for n in highlight::theme_names() {
                    println!("{n}");
                }
                std::process::exit(0);
            }
            "-s" | "--split" => c.split = Some(true),
            "-u" | "--unified" => c.split = Some(false),
            "--no-wrap" | "--nowrap" => c.wrap = false,
            "--tests" => c.tests = Some(true),
            "--no-tests" => c.tests = Some(false),
            "--popup" => c.popup = true,
            "--theme" => c.theme = args.next().ok_or("--theme needs a name")?,
            "-c" | "--cmd" => c.cmd = Some(args.next().ok_or("--cmd needs a command")?),
            "-l" | "--local" | "." => c.local = true,
            // git diff's own flags clash with jv's (-s is --no-patch there), so
            // -g ends jv's options: the rest goes to git untouched.
            "-g" | "--git" => c.git = Some(args.by_ref().collect()),
            // Hidden: offscreen render for UI work.
            "--snapshot" => {
                let v = args.next().ok_or("--snapshot needs WxH")?;
                let (w, h) = v.split_once('x').ok_or("--snapshot needs WxH")?;
                c.snapshot = Some((w.parse().map_err(|_| "bad width")?, h.parse().map_err(|_| "bad height")?));
            }
            "--keys" => c.keys = args.next().ok_or("--keys needs keys")?,
            "--out" => c.out = Some(args.next().ok_or("--out needs a path")?),
            "--" => c.gh.extend(args.by_ref()),
            _ => match a.strip_prefix("--theme=") {
                Some(t) => c.theme = t.to_string(),
                None => c.gh.push(a),
            },
        }
    }
    Ok(c)
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();
    match argv.get(1).map(String::as_str) {
        Some(agent::CHILD_FLAG) => return agent::child(&argv[2..]),
        Some(commit::CHILD_FLAG) => return commit::child(&argv[2..]),
        _ => {}
    }
    let cli = match parse_cli() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("jv: {e}");
            return ExitCode::from(2);
        }
    };
    let hl = match highlight::Hl::new(&cli.theme) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("jv: {e}");
            return ExitCode::from(2);
        }
    };
    if cli.prs {
        return run_prs(cli, hl);
    }

    let mut source = if let Some(c) = &cli.cmd {
        Source::Cmd(c.clone())
    } else if let Some(a) = &cli.git {
        Source::Git(a.clone())
    } else if cli.local {
        Source::Local
    } else {
        Source::Gh(cli.gh.clone())
    };
    // A pipe wins over the current branch's PR, but an empty or closed stdin
    // (cron, editors, agent shells) shouldn't hide it.
    let mut stdin_text = None;
    if matches!(&source, Source::Gh(a) if a.is_empty()) && !io::stdin().is_terminal() {
        if let Ok(t) = Source::Stdin.fetch() {
            if !t.trim().is_empty() {
                source = Source::Stdin;
                stdin_text = Some(t);
            }
        }
    }

    let chatty = io::stderr().is_terminal() && cli.snapshot.is_none() && !matches!(source, Source::Stdin);
    if chatty {
        eprint!("jv: {}…", source.label());
    }
    let clear = |chatty: bool| {
        if chatty {
            eprint!("\r\x1b[2K");
        }
    };
    let note: Option<String>;
    let fetched = match stdin_text {
        Some(t) => Ok((t, None)),
        None => source.fetch_noted(),
    };
    let text = match fetched {
        Ok((t, n)) => {
            note = n;
            t
        }
        Err(e) => {
            // No PR for this branch: show local changes rather than nothing.
            // Any other gh failure is an error, never a silent switch to local.
            let fallback = match &source {
                Source::Gh(a) if a.is_empty() && e.contains("no pull requests found") => {
                    Source::Local.fetch().ok().filter(|t| !t.trim().is_empty())
                }
                _ => None,
            };
            match fallback {
                Some(t) => {
                    source = Source::Local;
                    note = Some("no PR for this branch · showing local changes".to_string());
                    t
                }
                None => {
                    clear(chatty);
                    eprintln!("jv: {e}");
                    return ExitCode::FAILURE;
                }
            }
        }
    };
    clear(chatty);
    if text.trim().is_empty() {
        eprintln!("jv: empty diff ({})", source.label());
        // Bare `git diff` is unstaged only; say where staged work went.
        if matches!(&source, Source::Git(a) if a.is_empty())
            && Source::Git(vec!["--staged".into()]).fetch().is_ok_and(|t| !t.trim().is_empty())
        {
            eprintln!("jv: everything is staged; try `jg --staged` or `jg HEAD`");
        }
        return ExitCode::SUCCESS;
    }

    let show_tests = cli.tests.unwrap_or(!matches!(source, Source::Gh(_)));
    let meta_rx = match &source {
        Source::Gh(a) => Some(source::spawn_meta(a.clone())),
        _ => None,
    };
    let viewed = if cli.snapshot.is_some() { Viewed::ephemeral() } else { Viewed::load() };
    let opts = Opts { split: cli.split, wrap: cli.wrap, show_tests, popup: cli.popup };
    let mut app = App::new(source, &text, hl, background(), opts, viewed);
    app.meta_rx = meta_rx;
    if let Some(n) = note {
        app.flash(n);
    }

    if let Some((w, h)) = cli.snapshot {
        return snapshot::run(app, w, h, &cli.keys, cli.out.as_deref());
    }
    match run(app) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("jv: {e}");
            ExitCode::FAILURE
        }
    }
}

fn background() -> Palette {
    Palette::new(std::env::var("JV_BG").ok().and_then(|s| Rgb::parse(&s)).unwrap_or(Rgb(0x28, 0x2c, 0x34)))
}

/// jp: search for the PRs, then open on the first one. Its diff and the
/// rest load in the background, so the list shows as soon as GitHub answers.
fn run_prs(cli: Cli, hl: highlight::Hl) -> ExitCode {
    if cli.cmd.is_some() || cli.git.is_some() || cli.local {
        eprintln!("jp: -c, -g and -l are jv's; jp shows PRs");
        return ExitCode::from(2);
    }
    let q = match prs::Query::parse(&cli.gh) {
        Ok(q) => q,
        Err(e) => {
            eprintln!("jp: {e}");
            return ExitCode::from(2);
        }
    };
    let chatty = io::stderr().is_terminal() && cli.snapshot.is_none();
    if chatty {
        eprint!("jp: {}…", q.label());
    }
    let found = prs::list(&q, false);
    if chatty {
        eprint!("\r\x1b[2K");
    }
    let items = match found {
        Ok(v) => v,
        Err(e) => {
            eprintln!("jp: {e}");
            return ExitCode::FAILURE;
        }
    };
    if items.is_empty() {
        eprintln!("jp: no PRs found ({})", q.search());
        return ExitCode::SUCCESS;
    }
    let viewed = if cli.snapshot.is_some() { Viewed::ephemeral() } else { Viewed::load() };
    // Like a PR in jv: test files start hidden (T shows them).
    let opts = Opts { split: cli.split, wrap: cli.wrap, show_tests: cli.tests.unwrap_or(false), popup: cli.popup };
    let mut app = App::new(Source::Gh(Vec::new()), "", hl, background(), opts, viewed);
    app.start_prs(q, items);
    if let Some((w, h)) = cli.snapshot {
        return snapshot::run(app, w, h, &cli.keys, cli.out.as_deref());
    }
    match run(app) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("jp: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(mut app: App) -> io::Result<()> {
    let mut terminal = ratatui::init();
    let kitty = matches!(supports_keyboard_enhancement(), Ok(true));
    modes(true, kitty);
    let res = event_loop(&mut terminal, &mut app, kitty);
    modes(false, kitty);
    ratatui::restore();
    res
}

/// The terminal modes jv adds to ratatui's: mouse reports, bracketed paste (a
/// pasted newline mustn't submit the `c` box), and where the terminal has it,
/// the kitty keyboard protocol's first level, so shift+Enter and ^i arrive as
/// themselves instead of as Enter and Tab.
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

fn event_loop(terminal: &mut DefaultTerminal, app: &mut App, kitty: bool) -> io::Result<()> {
    let mut dirty = true;
    loop {
        dirty |= app.poll_meta();
        dirty |= app.poll_bg();
        dirty |= app.poll_prs();
        dirty |= app.tick();
        dirty |= app.autoscroll();
        if dirty {
            let s = terminal.size()?;
            app.layout_for(Rect::new(0, 0, s.width, s.height));
            app.prepare();
            terminal.draw(|f| ui::draw(app, f))?;
            dirty = false;
        }
        // A drag held past the diff's edge sends no events, so wake up to scroll it.
        // …and sooner while jp has diffs on the way.
        let wait = if app.autoscrolling() {
            20
        } else if app.pr_fetching() {
            50
        } else {
            250
        };
        if !event::poll(Duration::from_millis(wait))? {
            continue;
        }
        // Drain everything queued (fast wheel scrolling) before redrawing.
        loop {
            match app.handle(event::read()?) {
                Act::Quit => return Ok(()),
                Act::Suspend(cmd) => suspend(terminal, &cmd, kitty)?,
                Act::None => {}
            }
            dirty = true;
            if !event::poll(Duration::ZERO)? {
                break;
            }
        }
    }
}

/// Hand the terminal to a foreground program (a terminal $EDITOR), then resume.
fn suspend(terminal: &mut DefaultTerminal, cmd: &[String], kitty: bool) -> io::Result<()> {
    modes(false, kitty);
    ratatui::restore();
    if let Some((prog, args)) = cmd.split_first() {
        let _ = Command::new(prog).args(args).status();
    }
    *terminal = ratatui::init();
    modes(true, kitty);
    terminal.clear()
}
