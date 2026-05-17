# up — update installed apps/CLIs.
#
# Usage:
#   up            update everything registered below
#   up claude     update just claude
#   up wrangler   update just wrangler
#   up -l         list registered apps

# Registry: each app gets a `_up_<name>` function that performs the update.
# To add a new app, define `_up_<name>` and add its name to `_up_apps`.

_up_apps=(claude wrangler pi)

_up_claude() {
  command -v claude >/dev/null 2>&1 || { echo "claude: not installed"; return 1; }
  claude update
}

_up_wrangler() {
  command -v vp >/dev/null 2>&1 || { echo "wrangler: vp (vite+) not found"; return 1; }
  local out
  out=$(wrangler -v 2>&1)
  echo "$out"
  if [[ "$out" != *"update available"* ]]; then
    echo "wrangler is up to date!"
    return 0
  fi
  vp install -g wrangler
}

_up_pi() {
  command -v pi >/dev/null 2>&1 || { echo "pi: not installed"; return 1; }
  command -v vp >/dev/null 2>&1 || { echo "pi: vp (vite+) not found"; return 1; }
  vp update -g @earendil-works/pi-coding-agent
  pi update
}

function up() {
  if [[ "$1" == "-l" || "$1" == "--list" ]]; then
    printf '%s\n' "${_up_apps[@]}"
    return 0
  fi

  local targets
  if [[ $# -eq 0 ]]; then
    targets=("${_up_apps[@]}")
  else
    targets=("$@")
  fi

  local app fn rc=0
  for app in "${targets[@]}"; do
    fn="_up_${app}"
    if ! typeset -f "$fn" >/dev/null; then
      echo "up: unknown app '$app' (try: up -l)"
      rc=1
      continue
    fi
    echo "▲ updating $app..."
    if ! "$fn"; then
      echo "✗ $app update failed"
      rc=1
    fi
  done
  return $rc
}
