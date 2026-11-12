# Rex short names

Both Claude Code and Codex register `rex-autoname.sh` as a command `Stop`
hook, with `timeout: 30`. Claude Code also registers it as an `async: true`
`PostToolUse` hook (matcher `*`), so a chat is named during its first turn
instead of keeping Rex's generated `Window 1a2b3c4d` label until that turn
ends. The `PostToolUse` run happens once per session: a marker under
`${XDG_CACHE_HOME:-~/.cache}/rex-autoname/early` claims the session, and it is
dropped only when no title exists yet, so the next tool call retries. The
script emits `{}` on stdout, including when it skips renaming. The
registrations are in `~/.claude/settings.json` and `~/.codex/hooks.json`.

Stow the `claude` package to install the shared script and its sibling
`tab-short-name.py`. Both files must be installed together.

The hook only runs inside a Rex terminal (`REX_SESSION` and `REX_BLOCK` set).
It talks to Rex through the `rex` CLI: `block inspect` for the pane's window,
`window inspect` for the tab label and its panes, `block call … process` for
each pane's foreground program and cwd, `block call … title` as a title
fallback, and `window rename` / `block rename` to apply the name.

Names come from the agent's existing chat title. Explicit PR references use
`pr_12932`; Git branches never override chat topics. Titles get
a short snake_case topic from a tool-free Claude Haiku call (20-second
timeout). Safe mode disables hooks, plugins, and local instructions in this
call. Invalid output, unavailable auth, or timeouts fall back to two topic
words. Results are cached by title hash under
`${XDG_CACHE_HOME:-~/.cache}/rex-autoname/names`.

Tabs (Rex windows) with one chat get tab labels, including splits with editors
or shells: a pane counts as a chat when its foreground program is `claude` or
`codex`. Tabs with several chats get a label on the current pane (Rex block),
and only when that pane still has Rex's default label (`shell`) or one this
hook set. If the pane inventory fails, split tabs conservatively get pane
labels only. While `~/.config/rex/pane-labels.lua` runs (it rewrites every
pane label to `<directory>  <title>`, which already carries the chat title),
the hook leaves panes alone instead of fighting it;
`REX_AUTONAME_RENAME_PANES=auto|1|0` overrides that detection.

Tab labels are overwritten only when Rex generated them (`Window 1a2b3c4d`),
this hook set them, or they are a bare ticket ID / temporary
`PROD-3083 · slot 1` label. Human tab labels, `main`, `coordinator`, and any
cwd listed in `REX_AUTONAME_COORDINATOR_DIRS` (colon-separated, exact match;
unset falls back to `HERDR_AUTONAME_COORDINATOR_DIRS`, then to the private
`~/.config/rex-autoname/coordinator-dirs`, one directory per line) are
protected. The coordinator check covers the hook's cwd, the agent process's
cwd, and the launching shell's cwd, so a coordinator that `cd`s into a
worktree stays protected.
`REX_AUTONAME=0` disables naming; `REX_AUTONAME_DEBUG=1` logs decisions.

Run verification from the dotfiles root:

```sh
python3 -m unittest discover -s tests -p 'test_rex_autoname.py' -v
```

The Herdr-era `herdr-autoname.sh`, `herdr-short-name.py` and
`tests/test_herdr_autoname.py` are no longer registered anywhere.
