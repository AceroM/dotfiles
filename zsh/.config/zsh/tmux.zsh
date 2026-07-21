# Two tmux servers: default socket = interactive shells, `tmux -L bg` = background processes and detached agents.
# Default server: a / l / k / r          bg server: bg / ba / bl / bk / bgr / bgn

# stale aliases from older versions of this file shadow the functions below on re-source
unalias l a k r t tb bg ba bl bk bgr bgn sk 2>/dev/null

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

function _t_new_here() {
  local dir="${1:-$PWD}"
  local client="${2:-}"
  local sock="${3:-}"
  local name="$(_session_random_name "$sock")"

  _tm "$sock" new-session -ds "$name" -c "$dir"
  if [[ -n "$client" ]]; then
    _tm "$sock" switch-client -c "$client" -t "$name"
  else
    _tm "$sock" switch-client -t "$name"
  fi
}

_T_CHOOSE_FORMAT="#{session_name}#{?#{&&:#{!=:#{pane_title},#{session_name}},#{&&:#{!=:#{pane_title},zsh},#{!=:#{pane_title},#{pane_current_command}}}},: #{pane_title},}"

# the next session worth attending to — for now: first session whose agent is
# actively working (busy spinner is a braille glyph; idle is ✳).
# optional $2 excludes a session (e.g. the one you're about to kill)
function next_priority_session() {
  local sock="$1" exclude="$2" s title
  _tm "$sock" list-sessions -F '#S' 2>/dev/null | while read -r s; do
    [[ -n "$exclude" && "$s" == "$exclude" ]] && continue
    title=$(_tm "$sock" display-message -p -t "$s:0.0" '#{pane_title}' 2>/dev/null)
    if [[ "$title" == [⠀-⣿]* ]]; then
      echo "$s"
      return 0
    fi
  done
  return 1
}

# switch the attached client to the next priority session, then kill the session
# we left. with no priority session, fall back to the previous session in the
# list — unless we're the first one (no previous), in which case go to the next.
# used by the M-x binding in .tmux.conf
function _t_switch_next_and_kill() {
  local sock="$1" current="$2"
  local next="$(next_priority_session "$sock" "$current")"
  if [[ -n "$next" ]]; then
    _tm "$sock" switch-client -t "$next"
  else
    local first="$(_tm "$sock" list-sessions -F '#S' 2>/dev/null | sort | head -1)"
    if [[ "$current" == "$first" ]]; then
      _tm "$sock" switch-client -n
    else
      _tm "$sock" switch-client -p
    fi
  fi
  _tm "$sock" kill-session -t "$current"
}

# attach to <name> (creating it if missing, with optional <cmd>);
# no args: attach to an in-progress agent session if there is one, else fall back
# per <fallback>: "first" attaches to the first session, "picker" opens choose-tree
function _t_attach() {
  local sock="$1" fallback="$2" name="$3" session_cmd="$4"
  if [[ -n "$name" ]]; then
    if _tm "$sock" has-session -t "$name" 2>/dev/null; then
      _tm "$sock" attach-session -t "$name"
    elif [[ -n "$session_cmd" ]]; then
      _tm "$sock" new-session -s "$name" -n "$name" "$session_cmd"
    else
      _tm "$sock" new-session -s "$name" -n "$name"
    fi
  elif _tm "$sock" has-session 2>/dev/null; then
    local busy="$(next_priority_session "$sock")"
    if [[ -n "$busy" ]]; then
      _tm "$sock" attach-session -t "$busy"
    elif [[ "$fallback" == picker ]]; then
      _tm "$sock" attach-session \; choose-tree -Zs -F "$_T_CHOOSE_FORMAT"
    else
      local first="$(_tm "$sock" list-sessions -F '#S' 2>/dev/null | head -1)"
      _tm "$sock" attach-session -t "$first"
    fi
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

# ── default server (interactive socket) ─────────────────────────────
function a() { _t_attach "" first "$@" }
function l() { _t_list "" }
function k() { _t_kill "" "$@" }
function r() { _t_read "" "$@" }

# ── bg server (tmux -L bg) ──────────────────────────────────────────
# no args: attach to the first session; with args: same as `a` but on the bg server
function bg() { # shadows the zsh builtin; use `builtin bg` for job control
  if [[ $# -eq 0 ]]; then
    local first="$(_tm bg list-sessions -F '#S' 2>/dev/null | head -1)"
    if [[ -n "$first" ]]; then
      _tm bg attach-session -t "$first"
      return
    fi
  fi
  _t_attach bg first "$@"
}
function ba() { _t_attach bg picker "$@" } # picker
function bl() { _t_list bg }
alias bgl='bl'
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

# ── completion: complete existing session names ─────────────────────
# default-server names for a/k/r, bg-server names for bg/ba/bk/bgr
function _tm_complete_sessions() {
  local sock="$1" out
  out="$(_tm "$sock" list-sessions -F '#S' 2>/dev/null)"
  [[ -z "$out" ]] && return
  local -a sessions=(${(f)out})
  compadd -a sessions
}
function _tm_complete_default() { _tm_complete_sessions "" }
function _tm_complete_bg()      { _tm_complete_sessions bg }
if (( $+functions[compdef] )); then
  compdef _tm_complete_default a k r
  compdef _tm_complete_bg bg ba bk bgr
fi
