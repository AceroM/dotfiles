# Tailscale serve — expose localhost services to your tailnet over HTTPS.
# Tailnet-only (not public). For public access use `tailscale funnel`.
#
# Tailscale only allows HTTPS on ports 443, 8443, 10000, so at most 3 ports
# can be served at once. One command upserts the full set:
#
#   ts 5173,4321,3333   serve these local ports, and ONLY these
#   ts                  show current serve status
#
# Ports map in order to the HTTPS ports: 1st -> https:443, 2nd -> https:8443,
# 3rd -> https:10000. https:443 is the short URL, so put your primary first.
function ts() {
  if [[ $# -eq 0 ]]; then
    tailscale serve status
    return 0
  fi

  # Accept "ts 5173,4321,3333" or "ts 5173 4321 3333" (or a mix).
  local -a ports
  ports=(${(s:,:)${(j:,:)@}})

  local p
  for p in $ports; do
    if [[ "$p" != <-> ]]; then
      echo "Invalid port: $p"
      return 1
    fi
  done

  if (( ${#ports} > 3 )); then
    echo "At most 3 ports (Tailscale serves HTTPS only on 443, 8443, 10000)."
    return 1
  fi

  local -a https_ports=(443 8443 10000)
  tailscale serve reset
  local i
  for (( i = 1; i <= ${#ports}; i++ )); do
    tailscale serve --bg --https=${https_ports[i]} "http://localhost:${ports[i]}"
  done
  tailscale serve status
}
