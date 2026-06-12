unalias vc 2>/dev/null
vc() {
  if [[ -f ./scripts/vc.sh ]]; then
    ./scripts/vc.sh "$@"
  elif [[ -f ./scripts/vc.zsh ]]; then
    ./scripts/vc.zsh "$@"
  else
    vp check --fix "$@"
  fi
}

unalias dev 2>/dev/null
dev() {
  if [[ -f ./scripts/dev.sh ]]; then
    ./scripts/dev.sh "$@"
  else
    vp run t:dev "$@"
  fi
}

# dev <target> <worktree> <port> — complete targets (+ ls), then .claude/worktrees
# names of the chosen target, then free ladder ports (5174+ app, 4322+ web)
_dev_complete() {
  [[ -f ./scripts/dev.sh ]] || return 1
  if (( CURRENT == 2 )); then
    compadd app web agents ls
  elif (( CURRENT == 3 )); then
    local -a names
    names=("${(@f)$(command ls "./${words[2]}/.claude/worktrees" 2>/dev/null)}")
    names=(${names:#})
    (( ${#names} )) && compadd $names
  elif (( CURRENT == 4 )); then
    local -a busy free
    busy=(${(f)"$(command lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | command grep -oE ':[0-9]+ \(LISTEN\)$' | command grep -oE '[0-9]+')"})
    local p start=5174 end=5183
    [[ ${words[2]} == web ]] && { start=4322; end=4329; }
    free=()
    for ((p = start; p <= end; p++)); do
      (( ${busy[(I)$p]} )) || free+=($p)
    done
    (( ${#free} )) && compadd $free
  fi
}
if (( $+functions[compdef] )); then
  compdef _dev_complete dev
fi
