# Herdr short names

Both Claude Code and Codex register `herdr-autoname.sh` as a command `Stop`
hook, with `timeout: 30`. The script emits `{}` on stdout, including when it
skips renaming. The existing registrations are in `~/.claude/settings.json`
and `~/.codex/hooks.json`.

Stow the `claude` package to install the shared script and its sibling
`herdr-short-name.py`. Both files must be installed together.

Names come from the agent's existing chat title. Explicit PR references use
`pr_12932`; ticket branches and ticket tabs use `PROD-3083`. Other titles get
a short snake_case topic from a tool-free Claude Haiku call (20-second
timeout). Safe mode disables hooks, plugins, and local instructions in this
call. Invalid output, unavailable auth, or timeouts fall back to two topic
words. Results are cached by title hash under
`${XDG_CACHE_HOME:-~/.cache}/herdr-autoname/names`.

Single-pane tabs get tab labels; shared tabs get a label on the current pane.
Human tab labels, `main`, `coordinator`, and `~/Numeral` are protected.
`HERDR_AUTONAME=0` disables naming; `HERDR_AUTONAME_DEBUG=1` logs decisions.

Run verification from the dotfiles root:

```sh
python3 -m unittest discover -s tests -p 'test_herdr_autoname.py' -v
```
