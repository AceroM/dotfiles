alias gv="gh repo view -w"
alias ga="gh pr review --approve"
alias pv="gh pr view -w"
alias g="git"
alias gi="git init"
function x() {
  local msg="${1:-changes}"
  git add . && git commit -m "$msg" --no-verify && git push
}
function pl() { git pull origin $(sc) }
function gd() { gh pr diff "$@"; }
function gx() {
  gh pr diff "$1"
  gh pr view "$1"
  function gl() {
}
  local n=""
  local args=("$@")

  if [[ $# -gt 0 && "${@: -1}" =~ ^[0-9]+$ ]]; then
    n="${@: -1}"
    args=("${@:1:$#-1}")
  fi

  if [[ -n "$n" ]]; then
    git log --oneline -n "$n" -- "${args[@]}"
  else
    git log --oneline -- "${args[@]}"
  fi
}
function gs() { git show "$@" }
function sa() { git stash "$@" }
function di() { git diff "$@" }
function gr() { git reset --hard HEAD }
function ap() { git stash apply "$@" }
function fe() { git fetch --all --prune }
function rc() { git rebase --continue }
function in() { git init }
function ad() { git add "$@" }
function st() { git status }
function co() { git checkout "$@" }
function rb() { git rebase "$@" }
function sc() { git branch --show-current }
function cm() { git commit -m "$@" --no-verify; }
function wk() { git worktree list --porcelain | sed -n 's/^branch refs\/heads\///p'
}
function gc() {
    local current_branch=$(git branch --show-current)
    local base_branch=${1:-main}
    local repo_url=$(gh repo view --json url -q .url)
    open "${repo_url}/compare/${base_branch}...${current_branch}"
}
function ao() {
  if [[ $# -ne 1 ]]; then
    echo "Usage: ao <repo-name>"
    return 1
  fi
  git remote add origin "git@github.com:AceroM/$1.git"
}
function nr() {
  if [[ $# -ne 1 ]]; then
    echo "Usage: nr <repo-name>"
    return 1
  fi

  gh repo create "AceroM/$1" --private
}
function checkpoint() {
  local msg="${1:-checkpoint}"
  git stash push -m "$msg" && git stash apply
}
alias ch="checkpoint"
