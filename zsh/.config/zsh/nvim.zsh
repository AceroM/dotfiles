# Open file:line references with Neovim's +line syntax.
function nvim() {
  emulate -L zsh
  local MATCH MBEGIN MEND
  local -a match mbegin mend

  # Preserve real filenames containing a colon and all ordinary invocations.
  if [[ ! -e "$1" && "$1" =~ '^(.+):([0-9]+)$' ]]; then
    command nvim "+${match[2]}" "${match[1]}" "${@:2}"
  else
    command nvim "$@"
  fi
}
