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
