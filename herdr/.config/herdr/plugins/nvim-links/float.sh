#!/bin/sh
# Neovim in a centered Herdr popup (the `float` pane), at NVIM_LINKS_FILE's
# line NVIM_LINKS_LINE, column NVIM_LINKS_COL, from the file's repo root.
# open.py starts it for a ctrl-clicked code location with no Neovim beside it.
set -eu
file=${NVIM_LINKS_FILE:?no file to open}
dir=$(dirname -- "$file")
root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || root=$dir
cd "$root" 2>/dev/null || cd "$HOME"
# Plugin panes get the server's environment, whose PATH may stop short of Homebrew.
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
exec nvim "+call cursor(${NVIM_LINKS_LINE:-1}, ${NVIM_LINKS_COL:-1})" "+normal! zz" -- "$file"
