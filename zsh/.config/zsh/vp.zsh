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
