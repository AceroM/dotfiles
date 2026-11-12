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

use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq)]
pub struct Agent {
    /// What the prompt shows: `name`, else `kind(model)`, else `kind`.
    pub name: String,
    /// The command: claude, codex.
    pub kind: String,
    /// The agent's own arguments, `--model MODEL` last when there's a model.
    pub args: Vec<String>,
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
        Agent { name, kind: kind.to_string(), args }
    }

    /// The command it runs, as a shell would read it.
    pub fn command(&self) -> String {
        std::iter::once(self.kind.as_str()).chain(self.args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ")
    }
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

/// The configurations, and what was wrong with the file when it couldn't be
/// used (the defaults are used then).
pub fn load() -> (Vec<Agent>, Option<String>) {
    let path = file();
    let shown = shorten(&path);
    match std::fs::read_to_string(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (defaults(), None),
        Err(e) => (defaults(), Some(format!("{shown}: {e} · using the defaults"))),
        Ok(s) => match parse(&s) {
            Ok(a) => (a, None),
            Err(e) => (defaults(), Some(format!("{shown}: {e} · using the defaults"))),
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

/// A config file's `[[agent]]` tables, in order.
pub fn parse(s: &str) -> Result<Vec<Agent>, String> {
    let t: toml::Table = s.parse().map_err(|e: toml::de::Error| e.message().trim().to_string())?;
    if let Some(k) = t.keys().find(|k| *k != "agent") {
        return Err(format!("unknown key `{k}` (only [[agent]] tables go here)"));
    }
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
    Ok(out)
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
    pick_start(agents, env.as_deref(), last().as_deref())
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

fn last_file() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME").filter(|s| !s.is_empty()).map(PathBuf::from);
    base.unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/state")).join("o/last-agent")
}

/// The configuration picked last, by name.
fn last() -> Option<String> {
    std::fs::read_to_string(last_file()).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Remember `name` as the one picked last (⇧tab, ^1…^9). Written whole to a
/// temp file, then renamed, so another o starting never reads half of it.
pub fn remember(name: &str) {
    let path = last_file();
    let Some(dir) = path.parent() else { return };
    let tmp = dir.join(format!(".last-agent.{}", std::process::id()));
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
        .unwrap();
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
    fn the_defaults_are_the_three() {
        let names: Vec<_> = defaults().into_iter().map(|a| a.name).collect();
        assert_eq!(names, ["claude(opus)", "claude(fable)", "codex"]);
    }
}
