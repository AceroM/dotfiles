//! Configurations: the agents ⏎ can start, each named as the prompt shows it
//! (`claude(opus) >`). They're listed, in order, in
//!
//!   $XDG_CONFIG_HOME/o/config.toml    (else ~/.config/o/config.toml)
//!
//! as `[[agent]]` tables: `kind` is the command (claude,
//! codex); `model` goes to it as `--model MODEL` and into its name;
//! `args` are its own arguments; `name` is shown instead of `kind(model)`.
//! ⇧tab goes to the next one, ^1…^9 straight to the Nth, and o remembers
//! the one picked last, for the next time it starts:
//!
//!   $XDG_STATE_HOME/o/last-agent    (else ~/.local/state/o), its name
//!
//! $O_AGENT, when set, names the one to start on instead. Without the
//! config file, `defaults()`.
//!
//! `max_width`, at the top, is the most columns o draws in (the
//! `claude(opus) > ` included), so a wide pane doesn't stretch the text
//! across it: DEFAULT_MAX_WIDTH when it's left out, 0 for the pane's whole
//! width.
//!
//! Apart from them, the Claude profile (Profile): which Claude Code config
//! folder, so which account, the claude configurations start on. o finds
//! this computer's own; with only ~/.claude there's nothing to pick.

use std::path::PathBuf;

/// Columns o draws in at most, without `max_width`: the text wraps at about
/// 80, after `claude(opus) > `.
pub const DEFAULT_MAX_WIDTH: u16 = 100;

/// A `max_width` under this (but not 0) is refused: the prompt's name and
/// the list's keys need the room.
const MIN_MAX_WIDTH: u16 = 40;

/// What the config file says.
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub agents: Vec<Agent>,
    /// The most columns o draws in; 0: the terminal's width.
    pub max_width: u16,
}

impl Default for Config {
    fn default() -> Config {
        Config { agents: defaults(), max_width: DEFAULT_MAX_WIDTH }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Agent {
    /// What the prompt shows: `name`, else `kind(model)`, else `kind`.
    pub name: String,
    /// The command: claude, codex.
    pub kind: String,
    /// The agent's own arguments, `--model MODEL` last when there's a model.
    pub args: Vec<String>,
    /// Set for its process alone: a Claude profile's CLAUDE_CONFIG_DIR
    /// (Agent::on).
    pub env: Vec<(String, String)>,
}

impl Agent {
    fn new(kind: &str, model: Option<&str>, args: &[&str], name: Option<&str>) -> Agent {
        let mut args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        if let Some(m) = model {
            args.extend(["--model".to_string(), m.to_string()]);
        }
        let name = match (name, model) {
            (Some(n), _) => n.to_string(),
            (None, Some(m)) => format!("{kind}({m})"),
            (None, None) => kind.to_string(),
        };
        Agent { name, kind: kind.to_string(), args, env: Vec::new() }
    }

    /// This configuration on Claude profile `p`: a claude one gets the
    /// profile's CLAUDE_CONFIG_DIR, and its name after its own
    /// (`claude(opus)·2`). On the main profile, and for other kinds, it's
    /// as it is.
    pub fn on(&self, p: Option<&Profile>) -> Agent {
        let mut a = self.clone();
        if let Some(p) = p.filter(|p| !p.is_main() && self.kind == "claude") {
            a.name = format!("{}·{}", self.name, p.name);
            a.env.push(("CLAUDE_CONFIG_DIR".into(), p.dir.to_string_lossy().into_owned()));
        }
        a
    }

    /// What runs: `env K=V… kind args…`, or `kind args…` with no env.
    pub fn argv(&self) -> Vec<String> {
        let mut v = Vec::new();
        if !self.env.is_empty() {
            v.push("env".to_string());
            v.extend(self.env.iter().map(|(k, val)| format!("{k}={val}")));
        }
        v.push(self.kind.clone());
        v.extend(self.args.iter().cloned());
        v
    }

    /// The command it runs, as a shell would read it (paths under $HOME
    /// as `~`).
    pub fn command(&self) -> String {
        let env = self.env.iter().map(|(k, v)| format!("{k}={}", shorten(std::path::Path::new(v))));
        env.chain(std::iter::once(self.kind.clone())).chain(self.args.iter().cloned()).collect::<Vec<_>>().join(" ")
    }
}

/// A Claude Code profile: a config folder with its own sign-in (so its own
/// subscription and limits), as `c2` runs Claude Code with
/// CLAUDE_CONFIG_DIR=~/.claude-2. o finds them (profiles()): ~/.claude,
/// the main one, then each ~/.claude-NAME that Claude Code has run in (a
/// .claude.json in it). ^n goes to the next; the claude configurations
/// start on the one o is on. Like the configuration, o remembers the one
/// picked last ($XDG_STATE_HOME/o/last-profile), and $O_PROFILE names one
/// instead (O_PROFILE=2, O_PROFILE=main).
#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    /// `main` for ~/.claude; NAME for ~/.claude-NAME.
    pub name: String,
    /// Its folder: CLAUDE_CONFIG_DIR, for all but the main one.
    pub dir: PathBuf,
}

pub const MAIN: &str = "main";

impl Profile {
    pub fn is_main(&self) -> bool {
        self.name == MAIN
    }

    /// Its limits as its status line last saw them (rate-limits.json in its
    /// folder): `5h 12% · 7d 67%`. A window past its reset is left out
    /// (what it said is over). None without the file, or with nothing in it.
    pub fn usage(&self) -> Option<String> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
        usage(&std::fs::read_to_string(self.dir.join("rate-limits.json")).ok()?, now)
    }
}

fn usage(json: &str, now: f64) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let parts: Vec<String> = [("five_hour", "5h"), ("seven_day", "7d")]
        .iter()
        .filter_map(|(key, short)| {
            let pct = v[key]["used_percentage"].as_f64()?;
            let resets = v[key]["resets_at"].as_f64().unwrap_or(f64::MAX);
            (resets > now).then(|| format!("{short} {pct:.0}%"))
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
}

/// This computer's Claude profiles: the main one first, then the others by
/// name.
pub fn profiles() -> Vec<Profile> {
    find_profiles(&home())
}

/// The main profile alone (~/.claude), without looking for others.
pub fn find_main() -> Vec<Profile> {
    vec![Profile { name: MAIN.into(), dir: home().join(".claude") }]
}

fn find_profiles(home: &std::path::Path) -> Vec<Profile> {
    let mut more: Vec<Profile> = std::fs::read_dir(home)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.strip_prefix(".claude-")?.to_string();
            let dir = e.path();
            let ok = !name.is_empty() && name != MAIN && !name.contains(char::is_whitespace) && dir.join(".claude.json").is_file();
            ok.then_some(Profile { name, dir })
        })
        .collect();
    more.sort_by(|a, b| a.name.cmp(&b.name));
    let mut all = vec![Profile { name: MAIN.into(), dir: home.join(".claude") }];
    all.extend(more);
    all
}

/// The profile o starts on: the one $O_PROFILE names, else the one picked
/// last, else the main one.
pub fn start_profile(profiles: &[Profile]) -> (usize, Why) {
    let env = std::env::var("O_PROFILE").ok();
    pick_profile(profiles, env.as_deref(), read_state("last-profile").as_deref())
}

fn pick_profile(profiles: &[Profile], env: Option<&str>, last: Option<&str>) -> (usize, Why) {
    let at = |n: &str| profiles.iter().position(|p| p.name == n.trim());
    if let Some(i) = env.map(str::trim).filter(|s| !s.is_empty()).and_then(at) {
        return (i, Why::Env);
    }
    match last.and_then(at) {
        Some(i) => (i, Why::Last),
        None => (0, Why::First),
    }
}

/// Remember profile `name` as the one picked last (^n).
pub fn remember_profile(name: &str) {
    write_state("last-profile", name);
}

/// Without a config file: Claude Code on Opus, on Fable, then Codex (as the
/// `c` and `cx` aliases run them).
pub fn defaults() -> Vec<Agent> {
    let claude = ["--dangerously-skip-permissions"];
    vec![
        Agent::new("claude", Some("opus"), &claude, None),
        Agent::new("claude", Some("fable"), &claude, None),
        // In this process, not on Codex's background server.
        Agent::new("codex", None, &["--no-daemon", "--yolo"], None),
    ]
}

pub fn file() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME").filter(|s| !s.is_empty()).map(PathBuf::from);
    base.unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config")).join("o/config.toml")
}

/// The config, and what was wrong with the file when it couldn't be used
/// (the defaults are used then).
pub fn load() -> (Config, Option<String>) {
    let path = file();
    let shown = shorten(&path);
    match std::fs::read_to_string(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Config::default(), None),
        Err(e) => (Config::default(), Some(format!("{shown}: {e} · using the defaults"))),
        Ok(s) => match parse(&s) {
            Ok(c) => (c, None),
            Err(e) => (Config::default(), Some(format!("{shown}: {e} · using the defaults"))),
        },
    }
}

/// `path` with $HOME as `~`.
pub fn shorten(path: &std::path::Path) -> String {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    match home.as_deref().and_then(|h| path.strip_prefix(h).ok()) {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

/// A config file: its `max_width`, and its `[[agent]]` tables, in order.
pub fn parse(s: &str) -> Result<Config, String> {
    let t: toml::Table = s.parse().map_err(|e: toml::de::Error| e.message().trim().to_string())?;
    if let Some(k) = t.keys().find(|k| !matches!(k.as_str(), "agent" | "max_width")) {
        return Err(format!("unknown key `{k}` (max_width, then [[agent]] tables)"));
    }
    let max_width = match t.get("max_width") {
        None => DEFAULT_MAX_WIDTH,
        Some(v) => match v.as_integer() {
            Some(0) => 0,
            Some(n) if (MIN_MAX_WIDTH as i64..=u16::MAX as i64).contains(&n) => n as u16,
            _ => return Err(format!("`max_width` is a number of columns, {MIN_MAX_WIDTH} or more (0: the pane's width)")),
        },
    };
    let list = t.get("agent").and_then(|v| v.as_array()).filter(|a| !a.is_empty()).ok_or("no [[agent]] in it")?;
    let mut out: Vec<Agent> = Vec::new();
    for (i, a) in list.iter().enumerate() {
        let n = i + 1;
        let a = a.as_table().ok_or(format!("agent {n} isn't a table"))?;
        if let Some(k) = a.keys().find(|k| !matches!(k.as_str(), "kind" | "model" | "args" | "name")) {
            return Err(format!("agent {n}: unknown key `{k}` (kind, model, args, name)"));
        }
        let text = |k: &str| match a.get(k) {
            None => Ok(None),
            Some(v) => v.as_str().map(|s| Some(s.trim())).ok_or(format!("agent {n}: `{k}` isn't a string")),
        };
        let kind = text("kind")?.filter(|k| !k.is_empty()).ok_or(format!("agent {n} has no `kind` (claude, codex)"))?;
        if kind.contains(char::is_whitespace) {
            return Err(format!("agent {n}: `kind` is one word (claude, codex); the rest goes in `args`"));
        }
        let model = text("model")?.filter(|m| !m.is_empty());
        let name = text("name")?.filter(|m| !m.is_empty());
        let args: Vec<&str> = match a.get("args") {
            None => Vec::new(),
            Some(v) => v
                .as_array()
                .and_then(|l| l.iter().map(|x| x.as_str()).collect::<Option<Vec<_>>>())
                .ok_or(format!("agent {n}: `args` isn't a list of strings"))?,
        };
        let agent = Agent::new(kind, model, &args, name);
        if out.iter().any(|o| o.name == agent.name) {
            return Err(format!("two agents are named {} (give one a `name`)", agent.name));
        }
        out.push(agent);
    }
    Ok(Config { agents: out, max_width })
}

/// Why o starts on the configuration it does.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Why {
    Env,
    Last,
    First,
}

/// Where o starts: the configuration $O_AGENT names, else the one picked
/// last, else the first.
pub fn start(agents: &[Agent]) -> (usize, Why) {
    let env = std::env::var("O_AGENT").ok();
    pick_start(agents, env.as_deref(), read_state("last-agent").as_deref())
}

/// `env` by name, else the first of that kind; `last` by name only (a
/// configuration renamed or gone since is forgotten).
fn pick_start(agents: &[Agent], env: Option<&str>, last: Option<&str>) -> (usize, Why) {
    if let Some(want) = env.map(str::trim).filter(|s| !s.is_empty()) {
        let by_name = agents.iter().position(|a| a.name == want);
        if let Some(i) = by_name.or_else(|| agents.iter().position(|a| a.kind == want)) {
            return (i, Why::Env);
        }
    }
    match last.and_then(|n| agents.iter().position(|a| a.name == n.trim())) {
        Some(i) => (i, Why::Last),
        None => (0, Why::First),
    }
}

/// $XDG_STATE_HOME/o/FILE (else ~/.local/state/o/FILE).
fn state_file(file: &str) -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME").filter(|s| !s.is_empty()).map(PathBuf::from);
    base.unwrap_or_else(|| home().join(".local/state")).join("o").join(file)
}

/// What was picked last (last-agent, last-profile), by name.
fn read_state(file: &str) -> Option<String> {
    std::fs::read_to_string(state_file(file)).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Remember `name` as the configuration picked last (⇧tab, ^1…^9).
pub fn remember(name: &str) {
    write_state("last-agent", name);
}

/// Written whole to a temp file, then renamed, so another o starting never
/// reads half of it.
fn write_state(file: &str, name: &str) {
    let path = state_file(file);
    let Some(dir) = path.parent() else { return };
    let tmp = dir.join(format!(".{file}.{}", std::process::id()));
    let ok = std::fs::create_dir_all(dir).and_then(|_| std::fs::write(&tmp, format!("{name}\n")));
    if ok.and_then(|_| std::fs::rename(&tmp, &path)).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_come_from_kind_and_model() {
        let all = parse(
            r#"
            [[agent]]
            kind = "claude"
            model = "opus"
            args = ["--dangerously-skip-permissions"]

            [[agent]]
            kind = "codex"
            args = ["--yolo"]

            [[agent]]
            kind = "claude"
            model = "claude-fable-5-2"
            name = "fable"
            "#,
        )
        .unwrap()
        .agents;
        let names: Vec<_> = all.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["claude(opus)", "codex", "fable"]);
        assert_eq!(all[0].command(), "claude --dangerously-skip-permissions --model opus");
        assert_eq!(all[2].args, ["--model", "claude-fable-5-2"]);
    }

    #[test]
    fn says_what_is_wrong() {
        let err = |s: &str| parse(s).unwrap_err();
        assert_eq!(err(""), "no [[agent]] in it");
        assert!(err("[[agent]]\nkind = \"claude\"\nmodle = \"opus\"").contains("unknown key `modle`"));
        assert!(err("[[agent]]\nmodel = \"opus\"").contains("no `kind`"));
        assert!(err("[[agent]]\nkind = \"codex --yolo\"").contains("one word"));
        assert!(err("[[agent]]\nkind = \"codex\"\nargs = \"--yolo\"").contains("isn't a list"));
        assert!(err("[[agent]]\nkind = \"codex\"\n[[agent]]\nkind = \"codex\"").contains("two agents are named codex"));
        assert!(!err("[[agent]\n").is_empty());
        assert!(err("max_width = 20\n[[agent]]\nkind = \"codex\"").contains("40 or more"));
        assert!(err("max_width = \"wide\"\n[[agent]]\nkind = \"codex\"").contains("number of columns"));
    }

    #[test]
    fn max_width_defaults_to_100_and_0_turns_it_off() {
        let width = |s: &str| parse(&format!("{s}\n[[agent]]\nkind = \"codex\"")).unwrap().max_width;
        assert_eq!(width(""), DEFAULT_MAX_WIDTH);
        assert_eq!(width("max_width = 120"), 120);
        assert_eq!(width("max_width = 0"), 0);
    }

    #[test]
    fn starts_where_o_agent_says_else_where_it_was_left() {
        let all = defaults();
        assert_eq!(pick_start(&all, None, None), (0, Why::First));
        assert_eq!(pick_start(&all, None, Some("claude(fable)\n")), (1, Why::Last));
        // Renamed or gone since: the first.
        assert_eq!(pick_start(&all, None, Some("claude(sonnet)")), (0, Why::First));
        // $O_AGENT over it, by name or kind; one that matches nothing doesn't count.
        assert_eq!(pick_start(&all, Some("codex"), Some("claude(fable)")), (2, Why::Env));
        assert_eq!(pick_start(&all, Some("claude"), Some("codex")), (0, Why::Env));
        assert_eq!(pick_start(&all, Some("gemini"), Some("codex")), (2, Why::Last));
    }

    #[test]
    fn profiles_are_the_main_folder_then_each_claude_dash_name_claude_ran_in() {
        let home = std::env::temp_dir().join(format!("o-profiles-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        for (dir, used) in [(".claude", true), (".claude-work", true), (".claude-2", true), (".claude-empty", false), (".claude-main", true)] {
            std::fs::create_dir_all(home.join(dir)).unwrap();
            if used {
                std::fs::write(home.join(dir).join(".claude.json"), "{}").unwrap();
            }
        }
        std::fs::write(home.join(".claude.json"), "{}").unwrap();
        let names: Vec<_> = find_profiles(&home).into_iter().map(|p| p.name).collect();
        let _ = std::fs::remove_dir_all(&home);
        // ~/.claude-empty never ran Claude Code; ~/.claude-main would be
        // taken for the main one.
        assert_eq!(names, ["main", "2", "work"]);
        // No home folder at all: the main one, as o was before profiles.
        assert_eq!(find_profiles(std::path::Path::new("/nonexistent")).len(), 1);
    }

    #[test]
    fn a_claude_configuration_runs_on_the_profile() {
        let all = defaults();
        let main = Profile { name: MAIN.into(), dir: "/h/.claude".into() };
        let two = Profile { name: "2".into(), dir: "/h/.claude-2".into() };
        assert_eq!(all[0].on(Some(&main)), all[0]);
        assert_eq!(all[0].on(None), all[0]);
        let on2 = all[0].on(Some(&two));
        assert_eq!(on2.name, "claude(opus)·2");
        assert_eq!(on2.argv(), ["env", "CLAUDE_CONFIG_DIR=/h/.claude-2", "claude", "--dangerously-skip-permissions", "--model", "opus"]);
        assert_eq!(all[0].argv(), ["claude", "--dangerously-skip-permissions", "--model", "opus"]);
        // Codex has no Claude profile.
        assert_eq!(all[2].on(Some(&two)), all[2]);
    }

    #[test]
    fn starts_on_o_profile_else_the_last_else_main() {
        let ps = vec![Profile { name: MAIN.into(), dir: "/a".into() }, Profile { name: "2".into(), dir: "/b".into() }];
        assert_eq!(pick_profile(&ps, None, None), (0, Why::First));
        assert_eq!(pick_profile(&ps, None, Some("2\n")), (1, Why::Last));
        assert_eq!(pick_profile(&ps, Some("main"), Some("2")), (0, Why::Env));
        // Gone since (another computer, or the folder removed): main.
        assert_eq!(pick_profile(&ps, Some("work"), Some("3")), (0, Why::First));
    }

    #[test]
    fn usage_leaves_out_windows_past_their_reset() {
        let json = r#"{"five_hour":{"used_percentage":12.4,"resets_at":100},"seven_day":{"used_percentage":67,"resets_at":900},"updated_at":50}"#;
        assert_eq!(usage(json, 60.0).as_deref(), Some("5h 12% · 7d 67%"));
        assert_eq!(usage(json, 200.0).as_deref(), Some("7d 67%"));
        assert_eq!(usage(json, 1000.0), None);
        assert_eq!(usage(r#"{"five_hour":null,"seven_day":{"used_percentage":3,"resets_at":900}}"#, 0.0).as_deref(), Some("7d 3%"));
        assert_eq!(usage("not json", 0.0), None);
    }

    #[test]
    fn the_defaults_are_the_three() {
        let names: Vec<_> = defaults().into_iter().map(|a| a.name).collect();
        assert_eq!(names, ["claude(opus)", "claude(fable)", "codex"]);
    }
}
