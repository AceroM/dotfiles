alias dot="cd ~/.dotfiles"
d() {
  if [[ -f ./scripts/diff.sh ]]; then
    ./scripts/diff.sh "$@"
  elif [[ $# -eq 0 ]]; then
    # Everything uncommitted (staged + unstaged) since HEAD. Plain `git diff`
    # only shows unstaged, so staged files disappear from it — diff against
    # HEAD instead. (`di`/`dg` remain unstaged-only, `si` staged-only.)
    git diff HEAD
  else
    git diff "$@"
  fi
}
db() {
  git diff "$@" | bat
}
