# Herdr short names

Both Claude Code and Codex register `herdr-autoname.sh` as a command `Stop`
hook, with `timeout: 30`. Claude Code also registers it as an `async: true`
`PostToolUse` hook (matcher `*`), so a chat is named during its first turn
instead of keeping its tab number until that turn ends. The `PostToolUse` run
happens once per session: a marker under
`${XDG_CACHE_HOME:-~/.cache}/herdr-autoname/early` claims the session, and it is
dropped only when no title exists yet, so the next tool call retries. The
script emits `{}` on stdout, including when it skips renaming. The existing
registrations are in `~/.claude/settings.json` and `~/.codex/hooks.json`.

Stow the `claude` package to install the shared script and its sibling
`herdr-short-name.py`. Both files must be installed together.

Names come from the agent's existing chat title. Explicit PR references use
`pr_12932`; Git branches never override chat topics. Titles get
a short snake_case topic from a tool-free Claude Haiku call (20-second
timeout). Safe mode disables hooks, plugins, and local instructions in this
call. Invalid output, unavailable auth, or timeouts fall back to two topic
words. Results are cached by title hash under
`${XDG_CACHE_HOME:-~/.cache}/herdr-autoname/names`.

Tabs with one recognized chat get tab labels, including splits with editors or
shells. Tabs with several chats get a label on the current pane. If pane inventory
is unavailable, split tabs conservatively get pane labels only.
Bare ticket IDs and temporary `PROD-3083 · slot 1` labels migrate to topic names.
Human tab labels, `main`, `coordinator`, and any cwd listed in
`HERDR_AUTONAME_COORDINATOR_DIRS` (colon-separated, exact match) are protected.
The coordinator check covers both the session's current cwd and the pane's
launch cwd from `herdr pane get`, so a coordinator that `cd`s into a worktree
stays protected.
`HERDR_AUTONAME=0` disables naming; `HERDR_AUTONAME_DEBUG=1` logs decisions.

Run verification from the dotfiles root:

```sh
python3 -m unittest discover -s tests -p 'test_herdr_autoname.py' -v
```
