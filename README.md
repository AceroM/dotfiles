# Dotfiles

These are my dotfiles.

## Shared Slack skill

`stow cli agent-config` installs the read-only `slack-agent` CLI and the global Codex
skill in `~/.agents/skills/slack`. Share it with Claude Code using
`ln -s "$HOME/.agents/skills/slack" ~/.claude/skills/slack` (if that path is absent).
Run `slack-agent read '<message-url>'` for a full thread, or `slack-agent --help` for search and
channel history. Authentication reuses the signed-in macOS Slack desktop session.

## Private references

Keep machine-specific configuration and secrets under the ignored `private/` directory.
The pre-commit hook scans staged paths and content for terms listed in the local
`private/commit-denylist` file (one literal term per line, with no blank lines).
Enable it in a new checkout with `git config core.hooksPath .githooks` after
creating that file. The denylist itself stays outside Git.

## Startup items (macOS)

`startup` (in `mac/`) keeps each machine's login items, app helpers and LaunchAgents to an
allowlist in `private/startup.conf`, and makes every login fresh (no reopened windows/apps).
On a new Mac: `stow mac && startup init && startup edit && startup apply && startup fresh &&
startup enforce on`.
