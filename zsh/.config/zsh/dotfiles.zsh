alias dot="cd ~/.dotfiles"
d() {
  if [[ -f ./scripts/diff.sh ]]; then
    ./scripts/diff.sh "$@"
  else
    git diff "$@"
  fi
}
db() {
  git diff "$@" | bat
}
