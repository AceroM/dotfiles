dp() {
  if [[ -f ./scripts/deploy.sh ]]; then
    ./scripts/deploy.sh "$@"
  else
    doppler "$@"
  fi
}
function ds() { doppler secrets get "$@" --plain }
