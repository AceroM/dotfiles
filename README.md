# Dotfiles

These are my dotfiles.

## Shortcuts (Hammerspoon)

With `stow hammerspoon` and Hammerspoon running:

- **Fn+E** opens and focuses a Herdr tab immediately to the right of the current
  tab, using the current pane’s directory (while Ghostty is focused).
- **Fn+Q** toggles Quick Record.
- **Option+A** opens the artifacts server (`localhost:4620`) in Chrome, reusing its tab if one is
  open. **Option+Shift+A** launches or focuses PhotoCraft.
- **Fn+B** toggles horizontal scrolling from any app. While enabled, vertical
  mouse-wheel or trackpad scrolling moves sideways. Press it again to restore
  normal scrolling; a Hammerspoon reload also resets it to off.

## Shared Slack skill

`stow cli agent-config` installs the read-only `slack-agent` CLI and the global Codex
skill in `~/.agents/skills/slack`. Share it with Claude Code using
`ln -s "$HOME/.agents/skills/slack" ~/.claude/skills/slack` (if that path is absent).
Run `slack-agent read '<message-url>'` for a full thread, or `slack-agent --help` for search and
channel history. Authentication reuses the signed-in macOS Slack desktop session.

## browser-use (agents in the real browser)

`stow browser-use && browser-use install`, then in each browser profile: `chrome://extensions` →
Developer mode → **Load unpacked** → `~/.dotfiles/browser-use/.local/share/browser-use/extension`
(stable id `aneibjcaiaipkjajpalppgijoekiedko`). Claude Code and Codex both drive the browser through
the `browser-use` CLI and the shared skill in `~/.agents/skills/browser-use`; their tabs live in one
**Agents** tab group, so every herdr pane sees the same tabs. That is the only tab group it ever
makes: tabs it opens join that group, as do new tabs and popups opened by pages already in the
group (including links with `target="_blank"` or `rel="noopener"`). A second Agents group gets
merged back into it. If a window won't accept groups, the group gets its own window. `install`
also links the skill into
`~/.claude/skills`. No account, MCP server or remote-debugging port is needed; it needs `bun`. Run
`browser-use --help` for commands, and `browser-use reload` after editing the extension.

## artifacts (local page server)

`artifacts/` is a Rust server for agent-written pages at `localhost:4620`. It is not stowed:
`cd artifacts && cargo build --release`, then link `target/release/artifacts` into `~/.local/bin`.
Work-specific settings (`ARTIFACTS_SLOT_REPO`, `ARTIFACTS_TICKET_URL`) go in the private profile.
See `artifacts/README.md`.

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
