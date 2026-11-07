# Inside Zed's integrated terminal, `zed some/file.sh` spawns a brand new
# window. `--existing` reuses the window we're already sitting in, so the file
# just shows up as a tab. Passing a directory (a project) or any explicit flag
# falls through to the plain CLI behaviour.
zed() {
  local -a args=("$@")

  if (( $# )) && [[ $TERM_PROGRAM == "zed" || -n $ZED_TERM ]]; then
    local arg reuse=1
    for arg in "$@"; do
      # strip a trailing :line:column before testing for a directory
      if [[ $arg == -* || -d ${arg%%:*} ]]; then
        reuse=0
        break
      fi
    done
    (( reuse )) && args=(--existing "$@")
  fi

  command zed "${args[@]}"
}

alias z="zed"
alias z.="zed ."
alias zd="zed ~/.dotfiles"
