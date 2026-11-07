# Content-aware cat: render markdown with glow, everything else with bat.
# Usage: md ~/Downloads/report.md
md() {
  if [[ $# -eq 0 ]]; then
    bat
    return
  fi

  # fill the pane; glow's own default caps at 80. GLOW_WIDTH overrides, 0 = no wrap.
  local file width=${GLOW_WIDTH:-${COLUMNS:-0}}
  for file in "$@"; do
    case ${file:l} in
      *.md|*.markdown|*.mdx)
        glow --pager --width "$width" "$file"
        ;;
      *)
        bat "$file"
        ;;
    esac
  done
}
