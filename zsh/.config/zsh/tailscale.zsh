# Tailscale serve helpers — expose localhost services to your tailnet over HTTPS.
# Tailnet-only (not public). For public access use `tailscale funnel`.

# Show current serve config.
function tl() { tailscale serve status }

# Reset all serves.
function tsr() { tailscale serve reset }

# Expose a localhost port on https:443. Usage: to <local-port>
function to() {
  if [[ $# -ne 1 ]]; then
    echo "Usage: to <local-port>"
    return 1
  fi
  tailscale serve --bg --https=443 "http://localhost:$1"
}

# Close the serve on https:443. Usage: tc <local-port>
function tc() {
  if [[ $# -ne 1 ]]; then
    echo "Usage: tc <local-port>"
    return 1
  fi
  tailscale serve --https=443 off
}

# Expose a localhost port on a tailnet HTTPS port. Usage: tsp <https-port> <local-port>
# Valid HTTPS ports: 443, 8443, 10000.
function tsp() {
  if [[ $# -ne 2 ]]; then
    echo "Usage: tsp <https-port> <local-port>"
    echo "  HTTPS ports: 443, 8443, 10000"
    return 1
  fi
  tailscale serve --bg --https="$1" "http://localhost:$2"
}

# Turn off the serve on a given HTTPS port. Usage: tspoff <https-port>
function tspoff() {
  if [[ $# -ne 1 ]]; then
    echo "Usage: tspoff <https-port>"
    return 1
  fi
  tailscale serve --https="$1" off
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
