function mr() {
  local app="$1"

  if [[ -z "$app" ]]; then
    echo "Usage: mr <app>"
    echo "Example: mr server"
    return 1
  fi

  local app_dir="apps/$app"

  if [[ ! -d "$app_dir" ]]; then
    echo "Error: directory not found: $app_dir"
    return 1
  fi

  # Uses your existing t wrapper:
  # t n <session-name> <command>
  tmux new -d -s "$app" "cd \"$app_dir\" && bun run dev"
}
