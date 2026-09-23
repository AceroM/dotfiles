# Jev agent picker

`Ctrl-Option-;` opens this Herdr plugin in a centered popup. Type a task, name, or
topic to rank live coding agents with Jev. Use the arrow keys and Enter to focus
one, or Escape to close the popup. The list includes each agent's name, status,
and workspace and tab location.

The popup reads agents and recent terminal output through `herdr`, using the
same candidate loader as `hj`. It loads the TypeSafe key from the shell's
existing `~/.config/zsh/numeral.zsh` setup when Herdr's server environment does
not contain it.

The dotfiles `herdr` package symlinks the plugin into `~/.config/herdr/plugins`.
After a fresh stow, link and enable it with:

```sh
herdr plugin link ~/.config/herdr/plugins/jev-focus
herdr plugin enable miguel.jev-focus
herdr server reload-config
```
