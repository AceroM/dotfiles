# Prompt
#
# Toggle by swapping which PROMPT line is commented out, then `sz`.
# macOS's default ("%n@%m %1~ %# ", set in /etc/zshrc) shows user@host dir %.
# The "Last login: ..." banner is silenced by ~/.hushlogin (zsh/.hushlogin).

autoload -Uz add-zsh-hook
_prompt_git_branch() {
  local branch
  branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || git rev-parse --quiet --short HEAD 2>/dev/null)
  if [[ -n "$branch" ]]; then
    psvar=("$branch")
  else
    psvar=()
  fi
}
add-zsh-hook precmd _prompt_git_branch

# "{currentDir} {branch} ❯ ": last path component (~ at home) + git branch + ❯
# (U+276F, single-width, unlike ▶ → λ which are East Asian ambiguous width).
PROMPT='%1~%(1v. %1v.) ❯ '
# PROMPT='%1~ ❯ '
# PROMPT='❯ '
