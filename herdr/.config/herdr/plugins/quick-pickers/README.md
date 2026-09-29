# Quick Herdr pickers

- `Ctrl-Option-;`: agents ordered blocked, done, working, idle, unknown.
- `Ctrl-Option-Shift-;`: spaces in sidebar order.
- `Ctrl-Option-'`: the separate Jev semantic agent picker.

Type to filter names, titles, and locations locally. Use Up/Down or Page Up/Down
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
