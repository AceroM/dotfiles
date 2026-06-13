# Claude-style worktrees: <repo>/.claude/worktrees/<name> — the same layout
# Claude Code uses, so these functions and Claude-created worktrees mix freely.
#   wn <branch>  new worktree (+ setup hook) and cd in
#   ws [name]    switch to a worktree; no arg or "main" → main checkout
#   wl           list worktrees
#   wx [name]    remove a worktree (no arg: the one you're in)
#   wi <name>    re-run the setup hook (env files, deps) on a worktree
# Repo resolution lets them run from anywhere: the repo you're in (linked
# worktrees resolve back to the main checkout) → ./app (the orchestrator-root
# case, e.g. ~/work) → $WORKTREES_DEFAULT_REPO.
: ${WORKTREES_DEFAULT_REPO:=$HOME/work/app}

# zsh expands aliases while parsing function definitions, so a stale alias on
# any of these names (e.g. worktrunk's old `ws`) breaks re-sourcing in a live
# shell — drop them first
unalias wn ws wl wx wi 2>/dev/null

_wt_repo() {
  local gitdir
  if gitdir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
    print -r -- "${gitdir:h}"
  elif [[ -e $PWD/app/.git ]]; then
    print -r -- "$PWD/app"
  else
    print -r -- "$WORKTREES_DEFAULT_REPO"
  fi
}

# wn <branch> — create .claude/worktrees/<branch> (reusing the branch if it
# exists), run the repo's setup hook, and cd in. If the worktree already
# exists, just cd.
wn() {
  local name=$1 repo dir
  [[ -n $name ]] || { echo "usage: wn <branch>" >&2; return 1; }
  repo=$(_wt_repo)
  dir=$repo/.claude/worktrees/$name
  if [[ -d $dir ]]; then
    cd "$dir"
    return
  fi
  # keep worktrees out of git status without touching the tracked .gitignore
  grep -qxF '.claude/worktrees/' "$repo/.git/info/exclude" 2>/dev/null ||
    print '.claude/worktrees/' >>"$repo/.git/info/exclude"
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$name"; then
    git -C "$repo" worktree add "$dir" "$name" || return
  else
    git -C "$repo" worktree add -b "$name" "$dir" || return
  fi
  local setup=${repo:h}/scripts/worktree-setup.sh
  [[ -x $setup ]] && "$setup" "$repo" "$dir"
  cd "$dir"
}

# ws [name] — switch to a worktree; no arg (or "main") goes to the main checkout.
ws() {
  local repo=$(_wt_repo)
  if [[ -z $1 || $1 == main ]]; then
    cd "$repo"
    return
  fi
  local dir=$repo/.claude/worktrees/$1
  if [[ ! -d $dir ]]; then
    echo "no worktree '$1' in $repo" >&2
    git -C "$repo" worktree list >&2
    return 1
  fi
  cd "$dir"
}

wl() { git -C "$(_wt_repo)" worktree list "$@" }

# wx [name] — remove a worktree (branch is kept). With no arg, removes the
# worktree you're standing in and hops back to the main checkout. Extra args
# pass through to `git worktree remove` (e.g. wx foo --force).
wx() {
  local repo=$(_wt_repo) name=$1 came_from=
  if [[ -n $name ]]; then
    shift
  else
    local top=$(git rev-parse --show-toplevel 2>/dev/null)
    if [[ $top != $repo/.claude/worktrees/* ]]; then
      echo "usage: wx <name> [git-worktree-remove flags]" >&2
      return 1
    fi
    name=${top#$repo/.claude/worktrees/}
    came_from=$PWD
    cd "$repo"
  fi
  if ! git -C "$repo" worktree remove "$repo/.claude/worktrees/$name" "$@"; then
    [[ -n $came_from ]] && cd "$came_from"
    return 1
  fi
  echo "worktree gone; branch '$name' kept (delete: git -C $repo branch -D $name)"
}

# wi <name> — run the setup hook on an existing worktree, e.g. one Claude Code
# created without env files or node_modules.
wi() {
  local repo=$(_wt_repo)
  local dir=$repo/.claude/worktrees/${1:?usage: wi <name>}
  [[ -d $dir ]] || { echo "no worktree '$1' in $repo" >&2; return 1; }
  local setup=${repo:h}/scripts/worktree-setup.sh
  [[ -x $setup ]] || { echo "no setup hook at $setup" >&2; return 1; }
  "$setup" "$repo" "$dir"
}

_wt_complete() {
  local repo=$(_wt_repo)
  local -a names
  names=("${(@f)$(command ls "$repo/.claude/worktrees" 2>/dev/null)}")
  names=(${names:#})
  compadd main $names
}
if (( $+functions[compdef] )); then
  compdef _wt_complete wn ws wx wi
fi
