# up — check installed apps/CLIs.
#
# Usage:
#   up            list current versions and whether each is outdated
#   up list       same as `up`
#
# Registry: each app gets a `_up_<name>_status` function that prints one
# status line. To add a new app, define `_up_<name>_status` and add its
# name to `_up_apps`.

_up_apps=(claude wrangler pi)

_up_print() {
  # _up_print <name> <version> <state>
  printf '%-10s %-20s %s\n' "$1" "$2" "$3"
}

_up_claude_status() {
  if ! command -v claude >/dev/null 2>&1; then
    _up_print claude "-" "not installed"
    return
  fi
  local current latest
  current=$(claude --version 2>/dev/null | awk '{print $1}')
  latest=$(npm view @anthropic-ai/claude-code version 2>/dev/null)
  if [[ -z "$latest" ]]; then
    _up_print claude "${current:-?}" "unknown (npm lookup failed)"
  elif [[ "$current" == "$latest" ]]; then
    _up_print claude "$current" "up to date"
  else
    _up_print claude "$current" "outdated (latest: $latest)"
  fi
}

_up_wrangler_status() {
  if ! command -v wrangler >/dev/null 2>&1; then
    _up_print wrangler "-" "not installed"
    return
  fi
  local out current
  out=$(wrangler -v 2>&1)
  current=$(printf '%s\n' "$out" | head -n1 | awk '{print $NF}')
  if [[ "$out" == *"update available"* ]]; then
    local latest
    latest=$(printf '%s\n' "$out" | sed -n 's/.*update available \([^ ]*\).*/\1/p' | head -n1)
    _up_print wrangler "$current" "outdated${latest:+ (latest: $latest)}"
  else
    _up_print wrangler "$current" "up to date"
  fi
}

_up_pi_status() {
  if ! command -v pi >/dev/null 2>&1; then
    _up_print pi "-" "not installed"
    return
  fi
  local current latest
  current=$(pi --version 2>/dev/null | awk '{print $NF}')
  latest=$(npm view @earendil-works/pi-coding-agent version 2>/dev/null)
  if [[ -z "$latest" ]]; then
    _up_print pi "${current:-?}" "unknown (npm lookup failed)"
  elif [[ "$current" == "$latest" ]]; then
    _up_print pi "$current" "up to date"
  else
    _up_print pi "$current" "outdated (latest: $latest)"
  fi
}

function up() {
  if [[ $# -gt 0 && "$1" != "list" ]]; then
    echo "up: unknown command '$1' (usage: up [list])"
    return 1
  fi

  _up_print NAME VERSION STATUS
  local app fn
  for app in "${_up_apps[@]}"; do
    fn="_up_${app}_status"
    if ! typeset -f "$fn" >/dev/null; then
      _up_print "$app" "-" "no status function"
      continue
    fi
    "$fn"
  done
}
