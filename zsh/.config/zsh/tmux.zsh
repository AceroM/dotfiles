function _session_random_name() {
  local -a adjectives=("${SESSION_NAME_ADJECTIVES[@]}")
  local -a nouns=("${SESSION_NAME_NOUNS[@]}")
  local name

  while true; do
    name="${adjectives[RANDOM % ${#adjectives[@]} + 1]}-${nouns[RANDOM % ${#nouns[@]} + 1]}"
    tmux has-session -t "$name" 2>/dev/null || break
  done

  echo "$name"
}

function _t_compact() {
  local action="$1"
  shift
  t "$action" "$@"
}

alias tx='tmux source-file ~/.tmux.conf'
alias l='t l'
alias a='t a'
alias k='t k'
alias r='t r'

function t() {
  local cmd="$1"
  local name="$2"
  local session_cmd="$3"

  case "$cmd" in
  l)
    local s title
    tmux list-sessions -F '#S' 2>/dev/null | while read -r s; do
      cmd=$(tmux display-message -p -t "$s:0.0" '#{pane_current_command}' 2>/dev/null)
      title=$(tmux display-message -p -t "$s:0.0" '#{pane_title}' 2>/dev/null)
      if [[ "$cmd" == *claude* || "$cmd" == *node* || "$cmd" =~ ^[0-9]+\.[0-9]+ ]] &&
        [[ -n "$title" && "$title" != "$s" && "$title" != "zsh" && "$title" != "$cmd" ]]; then
        printf '%s: %s\n' "$s" "$title"
      else
        printf '%s\n' "$s"
      fi
    done
    ;;
  a)
    tmux attach-session -t "$name"
    ;;
  k)
    local port="$session_cmd"
    if [[ -n "$port" ]]; then
      local pid=$(lsof -ti :"$port" -sTCP:LISTEN)
      if [[ -n "$pid" ]]; then
        kill -9 "$pid"
        echo "Killed process on port $port (PID: $pid)"
      else
        echo "No process found on port $port"
      fi
    fi
    tmux kill-session -t "$name"
    ;;
  n)
    if [[ -z "$name" ]]; then
      name="$(_session_random_name)"
    fi

    if tmux has-session -t "$name" 2>/dev/null; then
      tmux attach-session -t "$name"
    else
      if [[ -n "$session_cmd" ]]; then
        tmux new-session -s "$name" -n "$name" "$session_cmd"
      else
        tmux new-session -s "$name" -n "$name"
      fi
    fi
    ;;
  r)
    local lines="${3:-30}"
    tmux capture-pane -pS -"$lines" -t "$name"
    ;;
  sk)
    tmux send-keys -t repl "$name" C-m && tmux capture-pane -pS -30 -t repl
    ;;
  *)
    tmux "$@"
    ;;
  esac
}
