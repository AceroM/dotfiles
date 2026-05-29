# Taildrop helpers — send/receive files over Tailscale from the CLI.
# Uses `tailscale file cp` and `tailscale file get` under the hood.

# List devices that can receive files.
function tdt() { tailscale file cp --targets }

# Send file(s) to a target host. Usage: tds <file...> <target>
# Target can be a hostname, IP, or MagicDNS name (no trailing colon needed).
function tds() {
  if [[ $# -lt 2 ]]; then
    echo "Usage: tds <file...> <target>"
    echo "  tdt   # list available targets"
    return 1
  fi
  local target="${@: -1}"
  local files=("${@:1:$#-1}")
  tailscale file cp "${files[@]}" "${target%:}:"
}

# Receive files from the taildrop inbox into a directory (default: current dir).
# Usage: tdg [dir]
function tdg() { tailscale file get --conflict=rename "${1:-.}" }

# Wait for a file to arrive, then receive it. Usage: tdw [dir]
function tdw() { tailscale file get --wait --conflict=rename "${1:-.}" }

# Loop and receive files as they arrive. Usage: tdl [dir]
function tdl() { tailscale file get --loop --conflict=rename "${1:-.}" }

# Send from stdin with a chosen filename. Usage: cmd | tdp <name> <target>
function tdp() {
  if [[ $# -ne 2 ]]; then
    echo "Usage: <cmd> | tdp <filename> <target>"
    return 1
  fi
  tailscale file cp --name "$1" - "${2%:}:"
}
