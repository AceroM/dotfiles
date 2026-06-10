# Two tmux servers: default socket = claude sessions, `tmux -L bg` = background processes.
# Claude server: a / l / k / r          bg server: bg / bgl / bk / bgr / bgn

function _tm() {
  local sock="$1"
  shift
  if [[ -n "$sock" ]]; then
    tmux -L "$sock" "$@"
  else
    tmux "$@"
  fi
}

function _session_random_name() {
  local sock="$1"
  local -a adjectives=("${SESSION_NAME_ADJECTIVES[@]}")
  local -a nouns=("${SESSION_NAME_NOUNS[@]}")
  local name

  while true; do
    name="${adjectives[RANDOM % ${#adjectives[@]} + 1]}-${nouns[RANDOM % ${#nouns[@]} + 1]}"
    _tm "$sock" has-session -t "$name" 2>/dev/null || break
  done

  echo "$name"
}

_T_CHOOSE_FORMAT="#{session_name}#{?#{&&:#{!=:#{pane_title},#{session_name}},#{&&:#{!=:#{pane_title},zsh},#{!=:#{pane_title},#{pane_current_command}}}},: #{pane_title},}"

# attach to <name> (creating it if missing, with optional <cmd>), or open the picker
function _t_attach() {
  local sock="$1" name="$2" session_cmd="$3"
  if [[ -n "$name" ]]; then
    if _tm "$sock" has-session -t "$name" 2>/dev/null; then
      _tm "$sock" attach-session -t "$name"
    elif [[ -n "$session_cmd" ]]; then
      _tm "$sock" new-session -s "$name" -n "$name" "$session_cmd"
    else
      _tm "$sock" new-session -s "$name" -n "$name"
    fi
  elif _tm "$sock" has-session 2>/dev/null; then
    _tm "$sock" attach-session \; choose-tree -Zs -F "$_T_CHOOSE_FORMAT"
  else
    local new_name="$(_session_random_name "$sock")"
    _tm "$sock" new-session -s "$new_name" -n "$new_name"
  fi
}

function _t_list() {
  local sock="$1" s cmd title dir
  _tm "$sock" list-sessions -F '#S' 2>/dev/null | while read -r s; do
    cmd=$(_tm "$sock" display-message -p -t "$s:0.0" '#{pane_current_command}' 2>/dev/null)
    title=$(_tm "$sock" display-message -p -t "$s:0.0" '#{pane_title}' 2>/dev/null)
    dir=$(_tm "$sock" display-message -p -t "$s:0.0" '#{b:pane_current_path}' 2>/dev/null)
    if [[ "$cmd" == *claude* || "$cmd" == *node* || "$cmd" =~ ^[0-9]+\.[0-9]+ ]] &&
      [[ -n "$title" && "$title" != "$s" && "$title" != "zsh" && "$title" != "$cmd" ]]; then
      printf '%s [%s]: %s\n' "$s" "$dir" "$title"
    else
      printf '%s [%s]\n' "$s" "$dir"
    fi
  done
}

function _t_kill() {
  local sock="$1" name="$2" port="$3"
  if [[ -n "$port" ]]; then
    local pid=$(lsof -ti :"$port" -sTCP:LISTEN)
    if [[ -n "$pid" ]]; then
      kill -9 "$pid"
      echo "Killed process on port $port (PID: $pid)"
    else
      echo "No process found on port $port"
    fi
  fi
  _tm "$sock" kill-session -t "$name"
}

function _t_read() {
  local sock="$1" name="$2" lines="${3:-30}"
  _tm "$sock" capture-pane -pS -"$lines" -t "$name"
}

# raw passthroughs
function t() { tmux "$@" }
function tb() { tmux -L bg "$@" }

alias tx='tmux source-file ~/.tmux.conf; tmux -L bg source-file ~/.tmux.conf 2>/dev/null'
alias tz='tx'

# ── claude server (default socket) ──────────────────────────────────
function a() { _t_attach "" "$@" }
function l() { _t_list "" }
function k() { _t_kill "" "$@" }
function r() { _t_read "" "$@" }

# ── bg server (tmux -L bg) ──────────────────────────────────────────
function bg() { _t_attach bg "$@" } # shadows the zsh builtin; use `builtin bg` for job control
function bgl() { _t_list bg }
function bk() { _t_kill bg "$@" }
function bgr() { _t_read bg "$@" }

# start a detached background process: bgn web "bun dev"
function bgn() {
  local name="${1:?usage: bgn <name> [cmd]}" cmd="$2"
  if _tm bg has-session -t "$name" 2>/dev/null; then
    echo "bg session '$name' already exists"
    return 1
  fi
  if [[ -n "$cmd" ]]; then
    _tm bg new-session -ds "$name" -c "$PWD" "$cmd"
  else
    _tm bg new-session -ds "$name" -c "$PWD"
  fi
  echo "started bg:$name"
}

# send a line to the repl session on the bg server, then show its output
function sk() {
  tmux -L bg send-keys -t repl "$1" C-m && tmux -L bg capture-pane -pS -30 -t repl
}
