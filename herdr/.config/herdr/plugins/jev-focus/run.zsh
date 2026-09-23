#!/bin/zsh
set -eu

if [[ -z "${TYPESAFE_AI_API_KEY:-}${TYPESAFE_API_KEY:-}" && -r "$HOME/.config/zsh/numeral.zsh" ]]; then
  source "$HOME/.config/zsh/numeral.zsh" >/dev/null
fi

exec "$HOME/.bun/bin/bun" "$HERDR_PLUGIN_ROOT/picker.ts"
