vc() {
  if [[ -f ./scripts/vc.sh ]]; then
    ./scripts/vc.sh "$@"
  else
    vp check --fix "$@"
  fi
}
