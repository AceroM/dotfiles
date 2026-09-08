# Tailscale serve — expose localhost services to your tailnet over HTTPS.
# Tailnet-only (not public). For public access use `tailscale funnel`.
#
# serve (unlike funnel, which is limited to 443/8443/10000) can use any HTTPS
# port, so we map up to 4 local ports onto a fixed set. One command upserts
# the full set:
#
#   ts 5173,4321,3333   serve these local ports, and ONLY these
#   ts                  show a port summary and current serve status
#   tss                 same as `ts` with no arguments
#
# Ports map in order to the HTTPS ports: 1st -> https:443, 2nd -> https:8443,
# 3rd -> https:10000, 4th -> https:9443. https:443 is the short URL (no :port),
# so put your primary first.

# Show configured routes and ports, whether each local target is listening,
# and Tailscale's full human-readable status.
function tss() {
  local config
  config="$(command tailscale serve status --json)" || return

  if ! command -v jq >/dev/null 2>&1; then
    echo "jq is required for the port summary; showing raw status." >&2
    command tailscale serve status
    return
  fi

  local summary
  summary="$(
    print -r -- "$config" | command jq -r '
      . as $config
      | ($config.TCP // {}) as $tcp
      | [
          $config.Web // {}
          | to_entries[]
          | (.value.Handlers // {})
          | to_entries[]
        ] as $web_routes
      | [
          ($web_routes[] | (.value.Proxy // empty)),
          ($tcp[] | (.TCPForward // empty))
        ] as $upstreams
      | ([
          $upstreams[]
          | try capture("^(?:[a-zA-Z][a-zA-Z0-9+.-]*://)?(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):(?<port>[0-9]+)(?:/.*)?$").port catch empty
        ]
        | unique
        | sort_by(tonumber)) as $local_ports
      | [
          (($web_routes | length) + ([$tcp[] | select((.TCPForward // "") != "")] | length)),
          ($tcp | length),
          ($local_ports | length),
          ($tcp | keys | sort_by(tonumber) | join(", ")),
          ($local_ports | join(", "))
        ]
      | @tsv
    '
  )" || return

  local routes tailscale_port_count local_port_count tailscale_ports local_ports
  IFS=$'\t' read -r routes tailscale_port_count local_port_count tailscale_ports local_ports <<< "$summary"

  printf 'Tailscale Serve: %s configured routes | %s Tailscale ports\n' \
    "$routes" "$tailscale_port_count"
  [[ -n "$tailscale_ports" ]] && printf 'Tailscale ports: %s\n' "$tailscale_ports"

  if [[ -n "$local_ports" ]] && command -v lsof >/dev/null 2>&1; then
    local -a listening_ports not_listening_ports
    local port
    for port in ${(s:, :)local_ports}; do
      if command lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        listening_ports+=("$port")
      else
        not_listening_ports+=("$port")
      fi
    done

    printf 'Local targets:   %s/%s listening\n' "${#listening_ports}" "$local_port_count"
    (( ${#listening_ports} )) && printf '  listening:     %s\n' "${(j:, :)listening_ports}"
    (( ${#not_listening_ports} )) && printf '  not listening: %s\n' "${(j:, :)not_listening_ports}"
  elif [[ -n "$local_ports" ]]; then
    printf 'Local ports:     %s\n' "$local_ports"
  fi

  echo
  command tailscale serve status
}

function ts() {
  if [[ $# -eq 0 || ( $# -eq 1 && "$1" == "status" ) ]]; then
    tss
    return
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

  if (( ${#ports} > 4 )); then
    echo "At most 4 ports (mapped to HTTPS 443, 8443, 10000, 9443)."
    return 1
  fi

  local -a https_ports=(443 8443 10000 9443)
  tailscale serve reset
  local i
  for (( i = 1; i <= ${#ports}; i++ )); do
    tailscale serve --bg --https=${https_ports[i]} "http://localhost:${ports[i]}"
  done
  tss
}
