#!/bin/zsh
set -eu

exec "$HOME/.bun/bin/bun" "$HERDR_PLUGIN_ROOT/picker.ts" "${HERDR_PLUGIN_ENTRYPOINT_ID:-agents}"
