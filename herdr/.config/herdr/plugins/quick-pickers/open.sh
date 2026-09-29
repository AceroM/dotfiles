#!/bin/sh
set -eu

case "${1:-}" in
  agents|spaces) ;;
  *) echo "usage: open.sh agents|spaces" >&2; exit 2 ;;
esac

exec "${HERDR_BIN_PATH:-herdr}" plugin pane open \
  --plugin "${HERDR_PLUGIN_ID:-miguel.quick-pickers}" \
  --entrypoint "$1"
