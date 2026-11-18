mod agent;
mod app;
mod commit;
mod diff;
mod doc;
mod edit;
mod fuzzy;
mod highlight;
mod net;
mod prs;
mod snapshot;
mod source;
mod stack;
mod rex_theme;
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
use theme::Palette;
use viewed::Viewed;

#[derive(serde::Deserialize)]
struct Cli {
    split: Option<bool>,
    wrap: bool,
    tests: Option<bool>,
    theme: Option<String>,
    popup: bool,
    snapshot: Option<(u16, u16)>,
    keys: String,
    out: Option<String>,
    prs: bool,
    net: bool,
    flat: bool,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some(agent::CHILD_FLAG) => return agent::child(&args[1..]),
        Some(commit::CHILD_FLAG) => return commit::child(&args[1..]),
        Some("--themes") => {
            for name in highlight::theme_names() {
                println!("{name}");
            }
            return ExitCode::SUCCESS;
        }
        Some("--view") if args.len() >= 3 => {}
        // Let the Go CLI parse public arguments to cargo run, then resume this build.
        _ => {
            use std::os::unix::process::CommandExt;
            let launcher = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../bin/jv");
            let mut cli = Command::new(launcher);
            if let Ok(exe) = std::env::current_exe() {
                cli.env("_JV_VIEWER", exe);
            }
            let err = cli.args(args).exec();
            eprintln!("jv: starting the CLI: {err}");
            return ExitCode::FAILURE;
        }
    }
    let cli: Cli = match serde_json::from_str(&args[1]) {
        Ok(cli) => cli,
        Err(e) => {
            eprintln!("jv: invalid viewer options: {e}");
            return ExitCode::from(2);
        }
    };
    let source = match args[2].as_str() {
        "pr" => Source::Gh(args[3..].to_vec()),
        "git" => Source::Git(args[3..].to_vec()),
        "local" => Source::Local,
        "stack" => Source::Stack(None),
        "cmd" if args.len() == 4 => Source::Cmd(args[3].clone()),
        kind => {
            eprintln!("jv: unknown diff source {kind:?}");
            return ExitCode::from(2);
        }
    };
    run_viewer(cli, source)
}

fn run_viewer(cli: Cli, mut source: Source) -> ExitCode {
    // On a light background (Rex in a light theme) the default syntax theme is GitHub's.
    let light = base().light;
    let syntax = cli.theme.clone().unwrap_or_else(|| if light { "GitHub" } else { highlight::DEFAULT_THEME }.to_string());
    let hl = match highlight::Hl::new(&syntax) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("jv: {e}");
            return ExitCode::from(2);
        }
    };
    if cli.net {
        return run_net(cli, hl, source);
    }
    if cli.prs {
        return run_prs(cli, hl, source);
    }

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
                    popup_pause(cli.popup);
                    return ExitCode::FAILURE;
                }
            }
        }
    };
    clear(chatty);
    source.set_stack_label(note.as_deref());
    if text.trim().is_empty() {
        eprintln!("jv: empty diff ({})", source.label());
        // Bare `git diff` is unstaged only; say where staged work went.
        if matches!(&source, Source::Git(a) if a.is_empty())
            && Source::Git(vec!["--staged".into()]).fetch().is_ok_and(|t| !t.trim().is_empty())
        {
            eprintln!("jv: everything is staged; try `jg --staged` or `jg HEAD`");
        }
        popup_pause(cli.popup);
        return ExitCode::SUCCESS;
    }

    let show_tests = cli.tests.unwrap_or(!matches!(source, Source::Gh(_)));
    let meta_rx = match &source {
        Source::Gh(a) => Some(source::spawn_meta(a.clone())),
        _ => None,
    };
    let viewed = if cli.snapshot.is_some() { Viewed::ephemeral() } else { Viewed::load() };
    let opts = Opts { split: cli.split, wrap: cli.wrap, show_tests, popup: cli.popup, flat: cli.flat };
    let mut app = App::new(source, &text, hl, background(), opts, viewed);
    app.meta_rx = meta_rx;
    if let Some(n) = note.filter(|_| !matches!(app.source, Source::Stack(_))) {
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

/// --popup with nothing to show (empty diff, gh failed): jv exits before its
/// screen ever opens, and the float would close on the message. Keep it up
/// until a key.
fn popup_pause(popup: bool) {
    use ratatui::crossterm::terminal::{disable_raw_mode, enable_raw_mode};
    if !popup || !io::stdin().is_terminal() {
        return;
    }
    eprint!("any key closes");
    let _ = enable_raw_mode();
    while let Ok(ev) = event::read() {
        if matches!(ev, event::Event::Key(k) if k.kind == event::KeyEventKind::Press) {
            break;
        }
    }
    let _ = disable_raw_mode();
}

/// The base colors: Rex's theme inside Rex, One Dark on $JV_BG elsewhere. Read once.
fn base() -> &'static rex_theme::Theme {
    static BASE: std::sync::OnceLock<rex_theme::Theme> = std::sync::OnceLock::new();
    BASE.get_or_init(|| rex_theme::theme(&["JV_BG"]))
}

fn background() -> Palette {
    Palette::new(base())
}

/// jp: search for the PRs, then open on the first one. Its diff and the
/// rest load in the background, so the list shows as soon as GitHub answers.
fn run_prs(cli: Cli, hl: highlight::Hl, source: Source) -> ExitCode {
    let Source::Gh(words) = source else {
        eprintln!("jp: -c, -g and -l are jv's; jp shows PRs");
        return ExitCode::from(2);
    };
    let q = match prs::Query::parse(&words) {
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
    // The PR list lives where the tree does, so jp ignores --flat.
    let opts = Opts {
        split: cli.split,
        wrap: cli.wrap,
        show_tests: cli.tests.unwrap_or(false),
        popup: cli.popup,
        flat: false,
    };
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

/// jn: list the open PRs (and any named ones), tick the asked-for set (or
/// the current branch's stack), and merge it in the background.
fn run_net(cli: Cli, hl: highlight::Hl, source: Source) -> ExitCode {
    let Source::Gh(words) = source else {
        eprintln!("jn: -c, -g and -l are jv's; jn shows PRs");
        return ExitCode::from(2);
    };
    let args = match net::Args::parse(&words) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("jn: {e}");
            return ExitCode::from(2);
        }
    };
    let q = args.query.clone();
    let repo = q.repo.clone().unwrap_or_default();
    let chatty = io::stderr().is_terminal() && cli.snapshot.is_none();
    if chatty {
        eprint!("jn: {}…", q.label());
    }
    // The search, the PRs named by number and origin's default branch, at once.
    let base = std::thread::spawn(net::default_branch);
    let nums = args.numbers.clone();
    let named = std::thread::spawn(move || net::by_numbers(&repo, &nums));
    let found = prs::list(&q, false);
    let named = named.join().unwrap_or_else(|_| Err("the PR lookup stopped".into()));
    let base = base.join().ok().and_then(Result::ok);
    if chatty {
        eprint!("\r\x1b[2K");
    }
    let (mut items, named) = match (found, named) {
        (Ok(f), Ok(n)) => (f, n),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("jn: {e}");
            return ExitCode::FAILURE;
        }
    };
    // Named PRs the search didn't find (someone else's, or past -n) go first.
    for pr in named.into_iter().rev() {
        if !items.iter().any(|x| x.number == pr.number) {
            items.insert(0, pr);
        }
    }
    if items.is_empty() {
        eprintln!("jn: no open PRs found ({})", q.search());
        return ExitCode::SUCCESS;
    }
    let ticked: std::collections::BTreeSet<u32> = if !args.numbers.is_empty() {
        args.numbers.iter().copied().collect()
    } else {
        let trunk = base.as_ref().map_or("main", |b| b.name.as_str());
        app::current_branch()
            .and_then(|b| items.iter().position(|x| x.head == b))
            .map(|i| app::stack_of(&items, i, trunk).into_iter().collect())
            .unwrap_or_default()
    };
    let viewed = if cli.snapshot.is_some() { Viewed::ephemeral() } else { Viewed::load() };
    let opts = Opts {
        split: cli.split,
        wrap: cli.wrap,
        show_tests: cli.tests.unwrap_or(false),
        popup: cli.popup,
        flat: false,
    };
    let mut app = App::new(Source::Gh(Vec::new()), "", hl, background(), opts, viewed);
    app.start_net(q, items, base, ticked);
    if let Some((w, h)) = cli.snapshot {
        return snapshot::run(app, w, h, &cli.keys, cli.out.as_deref());
    }
    match run(app) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("jn: {e}");
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
