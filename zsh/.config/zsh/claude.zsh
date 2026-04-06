function ce() {
  local s="claude-$(uuidgen | cut -d- -f1)"
  tmux new-session -d "$s" "claude --dangerously-skip-permissions"
  sleep 1
  tmux send-keys -t "$s:0.0" "$1" C-m
}

function tc() {
  local -a adjectives=("${SESSION_NAME_ADJECTIVES[@]}")
  local -a nouns=("${SESSION_NAME_NOUNS[@]}")
  local name
  while true; do
    name="${adjectives[RANDOM % ${#adjectives[@]} + 1]}-${nouns[RANDOM % ${#nouns[@]} + 1]}"
    tmux has-session -t "$name" 2>/dev/null || break
  done
  tmux new-session -ds "$name" "claude --dangerously-skip-permissions"
  tmux attach -t "$name"
}

function rl() {
  local cfg="${1:-dev}"
  tmux new-session -ds repl "doppler -c $cfg run -- bun repl"
  sleep 1
  tmux send-keys -t repl ".load out/load.ts" C-m
  tmux attach -t repl
}
