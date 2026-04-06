function lu() {
  local branch
  branch=$(git branch --show-current 2>/dev/null) || return 1

  if [[ -z "$branch" ]]; then
    echo "Not in a git repository"
    return 1
  fi

  lumen diff "main..${branch}"
}
