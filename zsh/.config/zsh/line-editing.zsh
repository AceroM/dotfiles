# Text-field keys on the command line. Rex's terminal sends modified arrows as
# xterm CSI sequences (ESC [ 1 ; <mod> D/C), which zsh doesn't bind by itself.
#
#   option+left/right        move by word
#   shift+left/right         select by character
#   option+shift+left/right  select by word
#
# The selection is zsh's region, shown highlighted. While it's active, typing
# replaces it, backspace/delete removes it (it lands in the kill ring, so
# ctrl+y brings it back), and any other key drops it and then does what it
# normally does. Adapted from jirutka/zsh-shift-select.
#
# Bound in the emacs keymap explicitly, since variables.zsh (sourced after
# this file) is what makes emacs the main keymap.

bindkey -M emacs '^[[1;3D' backward-word
bindkey -M emacs '^[[1;3C' emacs-forward-word  # to the word's end, as on macOS

# Start a selection if there isn't one, then run the movement the widget is
# named after (shift-select::backward-word runs backward-word).
function shift-select::select-and-invoke() {
  if (( !REGION_ACTIVE )); then
    zle set-mark-command -w
    zle -K shift-select
  fi
  zle ${WIDGET#shift-select::} -w
}

# Drop the selection, return to the main keymap and replay the key there.
function shift-select::deselect-and-input() {
  zle deactivate-region -w
  zle -K main
  zle -U "$KEYS"
}
zle -N shift-select::deselect-and-input

# Remove the selection.
function shift-select::kill-region() {
  zle kill-region -w
  zle -K main
}
zle -N shift-select::kill-region

# Replace the selection with the typed character.
function shift-select::replace-and-input() {
  zle kill-region -w
  zle -K main
  zle -U "$KEYS"
}
zle -N shift-select::replace-and-input

function {
  emulate -L zsh
  bindkey -N shift-select
  # Fallback for every key the selection doesn't handle itself.
  bindkey -M shift-select -R '^@'-'^?' shift-select::deselect-and-input
  bindkey -M shift-select -R ' '-'~' shift-select::replace-and-input
  bindkey -M shift-select '^?' shift-select::kill-region     # backspace
  bindkey -M shift-select '^H' shift-select::kill-region     # ctrl+h
  bindkey -M shift-select '^[[3~' shift-select::kill-region  # forward delete

  local seq widget
  for seq widget (
    '^[[1;2D' backward-char       # shift+left
    '^[[1;2C' forward-char        # shift+right
    '^[[1;4D' backward-word       # option+shift+left
    '^[[1;4C' emacs-forward-word  # option+shift+right
  ); do
    zle -N shift-select::$widget shift-select::select-and-invoke
    bindkey -M emacs $seq shift-select::$widget
    bindkey -M shift-select $seq shift-select::$widget
  done
}
