alias dot="cd ~/.dotfiles"
d() {
  if [[ -f ./scripts/diff.sh ]]; then
    ./scripts/diff.sh "$@"
  else
    git --no-pager diff "$@"
  fi
}
