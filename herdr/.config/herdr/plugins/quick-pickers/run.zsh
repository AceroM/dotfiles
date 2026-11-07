#!/bin/zsh
set -eu

mode="${HERDR_PLUGIN_ENTRYPOINT_ID:-agents}"
[[ "$mode" == sessions ]] && exec "$HOME/.bun/bin/bun" "$HERDR_PLUGIN_ROOT/sessions.ts"
exec "$HOME/.bun/bin/bun" "$HERDR_PLUGIN_ROOT/picker.ts" "$mode"
