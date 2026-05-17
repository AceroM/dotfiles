alias rg='rg --hidden --glob "!.git"'
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
