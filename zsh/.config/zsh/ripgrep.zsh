alias rg='rg --hidden --glob "!.git"'

# Open the first ripgrep match in Neovim at its matching line.
# Usage: rv 'tick rows' [rg options]
rv() {
  local match file remainder line
  match=$(rg --no-heading --line-number --max-count 1 "$@") || return
  file=${match%%:*}
  remainder=${match#*:}
  line=${remainder%%:*}
  nvim "+$line" "$file"
}

ra() {
  local dir=$PWD
  while [[ $dir != / ]]; do
    if [[ -f $dir/.raignore ]]; then
      rg -uu --ignore-file "$dir/.raignore" "$@"
      return
    fi
    dir=${dir:h}
  done
  rg -uu --glob '!node_modules' "$@"
}
