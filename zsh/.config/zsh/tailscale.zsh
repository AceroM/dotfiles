# Tailscale serve helpers — expose localhost services to your tailnet over HTTPS.
# Tailnet-only (not public). For public access use `tailscale funnel`.
#
# Mental model: `to <local-port>` opens, `tc <local-port>` closes.
# Tailscale only allows HTTPS on ports 443, 8443, 10000 — `to` picks the first
# free one; `tc` looks up which one is forwarding your local port.

# Internal: proxy target for a given HTTPS port (empty if none).
function _ts_proxy_for_https_port() {
  tailscale serve status --json 2>/dev/null | jq -r --arg p ":$1" '
    .Web // {} | to_entries[]
    | select(.key | endswith($p))
    | .value.Handlers["/"].Proxy // empty
  ' | head -1
}

# Internal: detect which named config matches the current serve state.
function _ts_active_config() {
  local p443 p8443
  p443=$(_ts_proxy_for_https_port 443)
  p8443=$(_ts_proxy_for_https_port 8443)
  if [[ "$p443" == "http://localhost:4321" && "$p8443" == "http://localhost:5173" ]]; then
    echo "app"
  elif [[ "$p443" == "http://localhost:5173" && -z "$p8443" ]]; then
    echo "vite"
  fi
}

# Show current serve config.
function tl() {
  local config
  config=$(_ts_active_config)
  if [[ -n "$config" ]]; then
    echo "config: $config"
  fi
  tailscale serve status
}

# Reset all serves.
function tsr() { tailscale serve reset }

# Internal: HTTPS port currently proxying a given local port (empty if none).
function _ts_https_port_for() {
  tailscale serve status --json 2>/dev/null | jq -r --arg p "http://localhost:$1" '
    .Web // {} | to_entries[]
    | select(.value.Handlers["/"].Proxy == $p)
    | .key | split(":")[-1]
  ' | head -1
}

# Internal: first unused HTTPS port (443, 8443, 10000), empty if all in use.
function _ts_free_https_port() {
  local used
  used=$(tailscale serve status --json 2>/dev/null | jq -r '.TCP // {} | keys[]')
  for p in 443 8443 10000; do
    if ! echo "$used" | grep -qx "$p"; then
      echo "$p"
      return
    fi
  done
}

# Expose a localhost port over HTTPS. Usage: to <local-port>
function to() {
  if [[ $# -ne 1 ]]; then
    echo "Usage: to <local-port>"
    return 1
  fi
  local existing
  existing=$(_ts_https_port_for "$1")
  if [[ -n "$existing" ]]; then
    echo "localhost:$1 is already served on https:$existing"
    return 0
  fi
  local https_port
  https_port=$(_ts_free_https_port)
  if [[ -z "$https_port" ]]; then
    echo "No free HTTPS port (443, 8443, 10000 all in use). Run \`tl\` to see what's serving."
    return 1
  fi
  tailscale serve --bg --https="$https_port" "http://localhost:$1"
}

# Close the serve for a localhost port. Usage: tc <local-port>
function tc() {
  if [[ $# -ne 1 ]]; then
    echo "Usage: tc <local-port>"
    return 1
  fi
  local https_port
  https_port=$(_ts_https_port_for "$1")
  if [[ -z "$https_port" ]]; then
    echo "No serve found for localhost:$1"
    return 1
  fi
  tailscale serve --https="$https_port" off
}

# App: expose web (4321) on https:443 and app (5173) on https:8443.
function app-serve-on() {
  tailscale serve --bg --https=443 http://localhost:4321
  tailscale serve --bg --https=8443 http://localhost:5173
}

function app-serve-off() {
  tailscale serve --https=443 off
  tailscale serve --https=8443 off
}

# Vite: expose app (5173) on https:443.
function vite-serve-on() {
  tailscale serve --bg --https=443 http://localhost:5173
}

function vite-serve-off() {
  tailscale serve --https=443 off
}

# Switch named serve config. Usage: ts <app|vite>
function ts() {
  if [[ $# -ne 1 ]]; then
    echo "Usage: ts <app|vite>"
    return 1
  fi
  local target=$1 current
  case "$target" in
    app|vite) ;;
    *) echo "Unknown config: $target (expected: app, vite)"; return 1 ;;
  esac
  current=$(_ts_active_config)
  if [[ "$current" == "$target" ]]; then
    echo "already on $target"
    return 0
  fi
  if [[ -n "$current" ]]; then
    echo "switching $current -> $target"
    "${current}-serve-off" >/dev/null
  else
    echo "starting $target"
  fi
  "${target}-serve-on"
}
