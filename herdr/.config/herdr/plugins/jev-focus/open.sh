#!/bin/sh
set -eu

exec "${HERDR_BIN_PATH:-herdr}" plugin pane open \
  --plugin "${HERDR_PLUGIN_ID:-miguel.jev-focus}" \
  --entrypoint picker \
  --env "HJ_SOURCE_PANE_ID=${HERDR_PANE_ID:-}"
