function kd() { defaults write com.apple.dock autohide-delay -float 1000; killall Dock }
function k9() { kill -9 "$@"}
function lf() {
  [[ $# -eq 0 ]] && { echo "Usage: lf <port> [port ...]"; return 1; }
  local port
  for port in "$@"; do
    lsof -i :"$port" | awk -v port="$port" 'NR>1 { print $2, port, $1 }' | sort -u
  done
}
function lk() {
  [[ $# -eq 0 ]] && { echo "Usage: lk <port> [port ...]"; return 1; }
  local pids
  pids=$(for port in "$@"; do lsof -ti :"$port"; done | sort -u)
  [[ -n "$pids" ]] && echo "$pids" | xargs kill
}
alias pp="pbpaste"
alias pc="pbcopy"
alias e="echo"
