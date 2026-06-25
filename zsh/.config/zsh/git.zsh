alias gv="gh repo view -w"
alias ga="gh pr review --approve"
alias pv="gh pr view -w"
alias g="git"
alias gi="git init"
function jw() {
  gh pr merge "$@" --merge --delete-branch
}
function jd() {
  gh pr diff "$@"
}
function jc() {
  gh pr checkout "$@"
}
function x() {
  if [[ -f ./scripts/x.sh ]]; then
    ./scripts/x.sh "$@"
    return
  fi

  local msg="${1:-changes}"
  local session_name="x-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")-$(date +%s)"

  tmux -L bg new-session -d -s "$session_name" "cd $(printf '%q' "$PWD") && git add . && git commit -m $(printf '%q' "$msg") --no-verify && git push"
}
function pl() {
  if [[ -f ./scripts/pl.sh ]]; then
    ./scripts/pl.sh "$@"
    return
  fi
  git pull origin $(sc)
}
function gd() { gh pr diff "$@"; }
# gn [pr] — open a PR's full diff in nvim with real per-file syntax highlighting
# (via diffview). Fetches the PR head into a local pr-<n> ref; does NOT switch
# your working branch. Defaults to the current branch's PR.
function gn() {
  local pr base
  pr="${1:-$(gh pr view --json number -q .number)}" || return 1
  base="$(gh pr view "$pr" --json baseRefName -q .baseRefName)" || return 1
  git fetch -q origin "$base" "pull/$pr/head:pr-$pr" || return 1
  nvim -c "DiffviewOpen origin/$base...pr-$pr"
}
# gnv [pr] — raw piped diff in nvim (single buffer; diff-structure highlighting only)
function gnv() { gh pr diff "$@" | nvim; }
# gnw [git-rev] [-- paths...] — open your uncommitted changes in nvim via diffview
# with real per-file syntax highlighting. No args = working tree vs index (same
# scope as `git diff`/`dg`): unstaged files under "Changes", staged ones under
# "Staged changes". Pass a rev (e.g. HEAD, main) to diff against something else.
function gnw() { nvim -c "DiffviewOpen $*"; }
function gb() { gh browse "$@" }
function gu() {
  git remote get-url origin | sed -E 's#git@github\.com:#https://github.com/#; s#\.git$##'
}
function gx() {
  gh pr diff "$1"
  gh pr view "$1"
}
# cn [pr] — build & submit a PR review interactively (tiered prompts: pick a
# file:line, type a comment, repeat, then submit via gh). Launches the
# pr-review TUI when run on a terminal.
#
# For automation, pipe a JSON array of inline comments on stdin to get the old
# batched-review behavior instead:
#   cn <body> [event]   (event: COMMENT | APPROVE | REQUEST_CHANGES, or $CN_EVENT)
#   cn 'Looks good, a few notes' <<'JSON'
#   [
#     { "path": "src/foo.ts", "line": 42, "side": "RIGHT", "body": "wrong var" },
#     { "path": "src/bar.ts", "start_line": 10, "line": 15, "side": "RIGHT", "body": "extract" }
#   ]
#   JSON
function cn() {
  # Interactive terminal + nothing piped in -> tiered TUI builder.
  if [ -t 0 ]; then
    pr-review "$@"
    return
  fi

  # Piped stdin -> legacy batched JSON review (for scripts/agents).
  local body="${1:-}"
  local event="${2:-${CN_EVENT:-COMMENT}}"
  local comments pr sha

  comments="$(cat)"

  pr=$(gh pr view --json number      -q .number)      || return 1
  sha=$(gh pr view --json headRefOid -q .headRefOid)  || return 1

  jq -n \
    --arg     body "$body" \
    --arg     sha "$sha" \
    --arg     event "$event" \
    --argjson comments "$comments" \
    '{commit_id:$sha, event:$event, comments:$comments}
     + (if $body == "" then {} else {body:$body} end)' \
  | gh api --method POST "repos/{owner}/{repo}/pulls/$pr/reviews" --input -
}
function gl() {
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
alias gm='git log --author="$(git config user.name)"'
# gh pr paths
function hp() { gh pr view --json files --jq '.files[].path' }
function gs() { git show "$@" }
function sa() { git stash "$@" }
function di() { git diff "$@" }
function dl() { git diff --numstat "$@" | awk '{a+=$1; d+=$2} END {print a+d}' }
function ns() {
  if [[ -f ./scripts/ns.sh ]]; then
    ./scripts/ns.sh "$@"
    return
  fi
  git diff --numstat HEAD "$@" | awk '{printf "+%-5s -%-5s %s\n", $1, $2, $3}'
}
function nss() {
  if [[ -f ./scripts/nss.zsh ]]; then
    ./scripts/nss.zsh "$@"
    return
  fi
  git diff --numstat "${1:-main}...HEAD" | awk 'NF {printf "+%-5s -%-5s %s\n", $1, $2, $3}'
}
# nd <path...> — full patch for one or more files from the PR (base defaults to main, override with ND_BASE)
function nd() { git diff "${ND_BASE:-main}...HEAD" -- "$@" }
function dg() {
  if [[ -f ./scripts/dg.sh ]]; then
    ./scripts/dg.sh "$@"
    return
  fi
  git --no-pager -c core.pager=cat -c pager.diff=false -c delta.features= diff "$@"
}
function did() { git --no-pager -c core.pager=cat -c pager.diff=false -c delta.features= diff "$@" }
function si() { git diff --staged }
function gr() { git reset --hard HEAD }
function sap() { git stash apply "$@" }
function ap() { git apply "$@" }
function fe() { git fetch --all --prune }
function rc() { git rebase --continue }
function in() { git init }
function ad() { git add "$@" }
function st() {
  if [[ -f ./scripts/status.sh ]]; then
    ./scripts/status.sh "$@"
  else
    git status "$@"
  fi
}
function co() { git checkout "$@" }
function cb() { git checkout -b "$@" }
alias c-='git checkout -'
function rb() { git rebase "$@" }
function sc() { git branch --show-current }
function cm() { git commit -m "$@" --no-verify; }
# wl (worktree list) lives in worktrees.zsh now
function gc() {
    local current_branch=$(git branch --show-current)
    local base_branch=${1:-main}
    local repo_url=$(gh repo view --json url -q .url)
    open "${repo_url}/compare/${base_branch}...${current_branch}"
}
function gj() {
  local target="$1"

  if [[ -z "$target" ]]; then
    echo "Usage: gj <path[:line]>"
    return 1
  fi

  local repo_url
  repo_url=$(gh repo view --json url -q .url 2>/dev/null)

  if [[ -z "$repo_url" ]]; then
    echo "Not in a GitHub repo"
    return 1
  fi

  local path="$target"
  local line=""

  if [[ "$target" =~ ^(.+):([0-9]+)$ ]]; then
    path="${match[1]}"
    line="${match[2]}"
  fi

  local branch
  branch=$(git branch --show-current)

  if [[ -z "$branch" ]]; then
    branch=$(git rev-parse HEAD)
  fi

  local url="${repo_url}/blob/${branch}/${path}"

  if [[ -n "$line" ]]; then
    url="${url}#L${line}"
  fi

  open "$url"
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
