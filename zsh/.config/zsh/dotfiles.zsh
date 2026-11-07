alias dot="cd ~/.dotfiles"
# The diff I read all day, so it gets the terse rendering: no file decorations,
# no hunk headers, no line numbers. `dr` (git.zsh) is the same diff through
# delta's full view for when I do want line numbers.
d() { DELTA_FEATURES=raw-view _d_diff "$@" }

_d_diff() {
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
