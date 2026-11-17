# Dotfiles

These are my dotfiles.

## Memory Guard

`./memory-guard/install.sh` installs the native macOS menu bar watchdog for
Node and Google Chrome. See [Memory Guard](memory-guard/README.md) for limits,
recovery behavior, and the event log.

## o (Rex agent prompt)

`stow o` installs the Go prompt, with directory-scoped slash presets and local
drafts. Ctrl+1/2 selects Claude Opus/Fable; Ctrl+3/4 selects Codex Sol/Astra.
See [o's README](o/.local/share/o/README.md) for installation, keys, and checks.
Existing installations from another checkout can keep their current links.

## Shortcuts (Hammerspoon)

With `stow hammerspoon` and Hammerspoon running:

- **Fn+E** opens and focuses a Herdr tab immediately to the right of the current
  tab, using the current pane’s directory (while Ghostty is focused). Herdr is retired;
  in Rex, **Cmd+N** does the same (`rex/.config/rex/init.lua`).
- **Fn+Q** toggles Quick Record.
- **Option+T** toggles ExcalidrawZ. Option+A types å (agent pages moved to `af`), and
  **Option+Shift+A** is left to Lid Awake.
- **Fn+B** toggles horizontal scrolling from any app. While enabled, vertical
  mouse-wheel or trackpad scrolling moves sideways. Press it again to restore
  normal scrolling; a Hammerspoon reload also resets it to off.

## Rex tabs

`stow rt` installs the Go tab browser. Run `rt` in a Rex terminal to see tabs
across sessions grouped by activity. Use `j/k` to move, `/` to filter, Enter to
focus the pane, `y`/`Y` to copy its block or agent session ID, and `;` to close.
Space marks tabs and `v` selects a range. `jv`'s `;` shortcut opens `rt`.
**Cmd+R** renames the current tab. See [rt/README.md](rt/README.md).

Copy a Rex tab or pane ID and press **Fn+Shift+T** to jump to it from any Rex session.
The shortcut accepts full `window:` or `block:` IDs and unique short IDs such as
`bf94a017`. **Fn+Y** copies the current pane's ID. **Fn+T** opens Rex's Go to Anything picker.

## Rex PR diff (jf)

`stow jv` installs `jv` (PR diff), `jf` (flat view), `jg` (git diff),
`jp` (PR list), and `jn` (net diff). They share a Go CLI and diff loader.
The interactive viewer uses Rust. The launchers build each part on demand
with Go and Cargo.

**Fn+D** (or `rex do jf_float`, from `stow jv rex`) opens `jf` in a large centered
float, in the directory of the pane you pressed it in: the branch's PR diff, or local changes when
there's no PR. Press it again inside the float to close it. In `jf`, `t` shows or hides test files
and `^p` goes to a file.

## Rex servers (stop them all)

**Option+Cmd+X** (or `servers-down`, from `stow cli rex`) stops every server in the Rex `servers`
session properly, then closes the session. Each server gets Ctrl-C first. Servers that other tabs
are connected to, like Temporal, stop last. Anything still running after 10s gets SIGTERM, then
SIGKILL. Docker containers a tab attached to are stopped, and the listening ports are checked to be
free. A Hammerspoon toast shows a spinner while it works, then ✓, or ✕ with what is still up.
`servers-down --dry-run` lists what it would stop; `--keep-tabs` keeps the session. Start
again with `rex new servers`, then `scripts/juno/dev-up-rex.sh`.

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
**Agents** tab group, so every Rex pane sees the same tabs. That is the only tab group it ever
makes: tabs it opens join that group, as do new tabs and popups opened by pages already in the
group (including links with `target="_blank"` or `rel="noopener"`). A second Agents group gets
merged back into it. If a window won't accept groups, the group gets its own window. `install`
also links the skill into
`~/.claude/skills`. No account, MCP server or remote-debugging port is needed; it needs `bun`. Run
`browser-use --help` for commands, and `browser-use reload` after editing the extension.

## af (agent pages)

Agents write pages as plain, self-contained `.html` files in `~/artifacts` (`$AF_DIR`); the rules
they follow are in the global agent instructions under "Pages". `af` (in `cli/`, `stow cli`) lists
the five most recently changed, `af 1` opens the newest in Chrome (focusing and reloading its tab
if it is already open), `af ls` lists them all and `af path 1` prints a page's path. `af add
file.html` copies a page in (with a same-named folder of images), and `pbpaste | af add - name`
saves HTML from stdin. `av` is the same list, but `av 1` prints the page's HTML instead of
opening it (`! av 1` puts it in front of Claude Code). There is no server or index: the list is the directory sorted by
modification time.

Vimium needs file access to work on these pages: open
`chrome://extensions/?id=dbepggeogbaibhgnhhndojpepiihcmeb` and turn on **Allow access to file
URLs**, once per Chrome profile.

## artifacts (local page server)

`af` replaces this for new pages. `artifacts/` is a Rust server for agent-written pages at
`https://artifacts.localhost` (a portless alias to `localhost:4620`: `portless alias artifacts 4620`).
It is not stowed:
`cd artifacts && cargo build --release`, then link `target/release/artifacts` into `~/.local/bin`.
`artifacts/app/bundle.sh` installs the native app (`~/Applications/Artifacts.app`).
Work-specific settings (`ARTIFACTS_SLOT_REPO`, `ARTIFACTS_TICKET_URL`) go in the private profile.
See `artifacts/README.md`.

## Private references

Keep machine-specific configuration and secrets under the ignored `private/` directory.

Rex loads `~/.config/rex/private.lua` last when it exists, for machine-local keys and actions
(Hammerspoon forwards **Fn+P** as ctrl+alt+p for one of them). The `private` package also holds
files that don't belong in `~`, so stow it with ignores:
`stow --ignore=commit-denylist --ignore='startup\.conf' --ignore='archive-purged-skills.*' --ignore=dance-emoji private`.
The pre-commit hook scans staged paths and content for terms listed in the local
`private/commit-denylist` file (one literal term per line, with no blank lines).
Enable it in a new checkout with `git config core.hooksPath .githooks` after
creating that file. The denylist itself stays outside Git.

Git identity belongs in the machine-local `~/.config/git/identity.gitconfig`,
which `git/.gitconfig` includes. Set `user.name` and `user.email` in that file
before making commits on a new machine.
