# Quick Herdr pickers

- `Ctrl-Option-;`: agents ordered blocked, done, working, idle, unknown (direct popup bound in config.toml).
- `Ctrl-Option-Shift-;`: spaces in sidebar order (direct popup bound in config.toml).
- `Ctrl-Option-'`: the separate Jev semantic agent picker.
- `fn-a` / `fn-s` (Hammerspoon, `herdrkeys.lua`): toggle the agents / spaces picker from any app.

Pressing a picker's key again closes it; the other picker's key swaps to it.
Digits 1-9 focus that numbered row immediately instead of filtering.

Type to filter names, titles, and locations locally; Ctrl-W or Option-Backspace deletes a word. Use Up/Down or Page Up/Down
to choose, Enter to focus, Ctrl-R to refresh, and Escape to close. The quick
pickers make one `herdr api snapshot` request when opened or refreshed; they do
not read terminal output or call Jev.

The dotfiles `herdr` package stows this directory into
`~/.config/herdr/plugins/quick-pickers`. After a fresh stow:

```sh
herdr plugin link ~/.config/herdr/plugins/quick-pickers
herdr plugin enable miguel.quick-pickers
herdr server reload-config
```
