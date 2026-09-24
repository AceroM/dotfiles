#!/bin/zsh

if [[ -z "${TYPESAFE_AI_API_KEY:-}${TYPESAFE_API_KEY:-}" && -r "$HOME/.config/zsh/typesafe.zsh" ]]; then
  source "$HOME/.config/zsh/typesafe.zsh" >/dev/null
fi

set -eu
exec "$HOME/.bun/bin/bun" "$HERDR_PLUGIN_ROOT/picker.ts"
