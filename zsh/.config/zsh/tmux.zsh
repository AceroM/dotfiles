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
alias tz='tmux source-file ~/.tmux.conf'
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
    local s title dir
    tmux list-sessions -F '#S' 2>/dev/null | while read -r s; do
      cmd=$(tmux display-message -p -t "$s:0.0" '#{pane_current_command}' 2>/dev/null)
      title=$(tmux display-message -p -t "$s:0.0" '#{pane_title}' 2>/dev/null)
      dir=$(tmux display-message -p -t "$s:0.0" '#{b:pane_current_path}' 2>/dev/null)
      if [[ "$cmd" == *claude* || "$cmd" == *node* || "$cmd" =~ ^[0-9]+\.[0-9]+ ]] &&
        [[ -n "$title" && "$title" != "$s" && "$title" != "zsh" && "$title" != "$cmd" ]]; then
        printf '%s [%s]: %s\n' "$s" "$dir" "$title"
      else
        printf '%s [%s]\n' "$s" "$dir"
      fi
    done
    ;;
  a)
    if [[ -n "$name" ]]; then
      tmux attach-session -t "$name"
    elif tmux has-session 2>/dev/null; then
      tmux attach-session \; choose-tree -Zs -F "#{session_name}#{?#{&&:#{!=:#{pane_title},#{session_name}},#{&&:#{!=:#{pane_title},zsh},#{!=:#{pane_title},#{pane_current_command}}}},: #{pane_title},}"
    else
      local new_name="$(_session_random_name)"
      tmux new-session -s "$new_name" -n "$new_name"
    fi
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
