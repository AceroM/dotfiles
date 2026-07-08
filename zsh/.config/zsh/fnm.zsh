if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --use-on-cd --shell zsh)"
elif [ -x "/opt/homebrew/opt/fnm/bin/fnm" ]; then
  export PATH="/opt/homebrew/opt/fnm/bin:$PATH"
  eval "$(fnm env --use-on-cd --shell zsh)"
elif [ -x "$HOME/.local/share/fnm/fnm" ]; then
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env --use-on-cd --shell zsh)"
elif [ -x "$HOME/.fnm/fnm" ]; then
  export PATH="$HOME/.fnm:$PATH"
  eval "$(fnm env --use-on-cd --shell zsh)"
fi
