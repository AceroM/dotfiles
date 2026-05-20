# up — check and update installed apps/CLIs.
#
# Usage:
#   up            list current versions and whether each is outdated
#   up list       same as `up`
#   up update     update any outdated apps
#   up <name>     update just that app (e.g. `up claude`, `up pi`)
#
# Registry: each app gets a `_up_<name>_status` and `_up_<name>_update`
# function. To add a new app, define both and add its name to `_up_apps`.

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

_up_claude_update() {
  npm install -g @anthropic-ai/claude-code
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

_up_wrangler_update() {
  npm install -g wrangler
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

_up_pi_update() {
  npm install -g @earendil-works/pi-coding-agent
}

_up_list() {
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

_up_one() {
  # _up_one <app> — update a single app, regardless of current status.
  local app=$1 fn="_up_${1}_update"
  if ! typeset -f "$fn" >/dev/null; then
    echo "up: no update function for '$app'" >&2
    return 1
  fi
  echo "==> updating $app"
  "$fn"
}

_up_update_outdated() {
  local app status_fn line
  for app in "${_up_apps[@]}"; do
    status_fn="_up_${app}_status"
    typeset -f "$status_fn" >/dev/null || continue
    line=$("$status_fn")
    if [[ "$line" == *"outdated"* ]]; then
      _up_one "$app"
    fi
  done
}

function up() {
  if [[ $# -eq 0 || "$1" == "list" ]]; then
    _up_list
    return
  fi

  case "$1" in
    update)
      _up_update_outdated
      ;;
    *)
      if (( ${_up_apps[(Ie)$1]} )); then
        _up_one "$1"
      else
        echo "up: unknown command '$1' (usage: up [list|update|<app>])" >&2
        return 1
      fi
      ;;
  esac
}
