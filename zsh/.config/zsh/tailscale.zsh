# Tailscale serve helpers — expose localhost services to your tailnet over HTTPS.
# Tailnet-only (not public). For public access use `tailscale funnel`.
#
# Mental model: `to <local-port>` opens, `tc <local-port>` closes.
# Tailscale only allows HTTPS on ports 443, 8443, 10000 — `to` picks the first
# free one; `tc` looks up which one is forwarding your local port.

# Show current serve config.
function tl() { tailscale serve status }

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

# Porio: expose web (4321) on https:443 and app (5173) on https:8443.
function porio-serve-on() {
  tailscale serve --bg --https=443 http://localhost:4321
  tailscale serve --bg --https=8443 http://localhost:5173
}

function porio-serve-off() {
  tailscale serve --https=443 off
  tailscale serve --https=8443 off
}
