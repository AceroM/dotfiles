function app-ports() {
  local min="${APP_PORTS_MIN:-1024}"
  local max="${APP_PORTS_MAX:-65535}"

  if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    echo "Usage: app-ports [min [max]]"
    echo "Lists listening TCP ports in the app range; defaults to ${min}-${max}."
    return 0
  fi

  [[ $# -ge 1 ]] && min="$1"
  [[ $# -ge 2 ]] && max="$2"

  if [[ "$min" != <-> || "$max" != <-> || "$min" -gt "$max" ]]; then
    echo "Usage: app-ports [min [max]]" >&2
    return 1
  fi

  local rows
  rows="$(
    command lsof -nP -iTCP -sTCP:LISTEN -F pcPn 2>/dev/null |
      command awk -v min="$min" -v max="$max" '
        /^p/ { pid = substr($0, 2); next }
        /^c/ { cmd = substr($0, 2); next }
        /^n/ {
          name = substr($0, 2)
          port = name
          sub(/ .*/, "", port)
          sub(/.*:/, "", port)
          if (port ~ /^[0-9]+$/ && port >= min && port <= max) {
            key = port ":" pid
            if (!seen[key]++) print port "\t" pid "\t" cmd
          }
        }
      ' |
      command sort -n -k1,1 -k2,2
  )"

  if [[ -z "$rows" ]]; then
    echo "No listening app ports found in ${min}-${max}."
    return 0
  fi

  local -A pane_by_pid
  local pane_pid pane_name
  while IFS=$'\t' read -r pane_pid pane_name; do
    [[ -n "$pane_pid" && -n "$pane_name" ]] && pane_by_pid[$pane_pid]="$pane_name"
  done < <(
    command tmux list-panes -a -F '#{pane_pid}\t#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null
    command tmux -L bg list-panes -a -F '#{pane_pid}\tbg/#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null
  )

  printf '%-6s %-8s %-18s %-18s %-42s %s\n' PORT PID OWNER COMMAND CWD URL
  local port pid cmd cwd owner walk parent
  while IFS=$'\t' read -r port pid cmd; do
    owner="-"
    walk="$pid"
    while [[ "$walk" == <-> && "$walk" -gt 1 ]]; do
      if [[ -n "${pane_by_pid[$walk]}" ]]; then
        owner="${pane_by_pid[$walk]}"
        break
      fi
      parent="$(command ps -o ppid= -p "$walk" 2>/dev/null | command tr -d ' ')"
      [[ -z "$parent" || "$parent" == "$walk" ]] && break
      walk="$parent"
    done

    cwd="$(
      command lsof -a -p "$pid" -d cwd -Fn 2>/dev/null |
        command sed -n 's/^n//p' |
        command head -1
    )"
    [[ -z "$cwd" ]] && cwd="-"
    cwd="${cwd/#$HOME/~}"
    printf '%-6s %-8s %-18s %-18s %-42s http://localhost:%s\n' "$port" "$pid" "$owner" "$cmd" "$cwd" "$port"
  done <<< "$rows"
}

unalias ports 2>/dev/null
function ports() { app-ports "$@" }
