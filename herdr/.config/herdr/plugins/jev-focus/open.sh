#!/bin/sh
set -eu

herdr="${HERDR_BIN_PATH:-herdr}"

# 110 cols wide (title + location); two lines per agent plus the header, footer,
# and popup frame, capped at 80% of the client.
size=$("$herdr" api snapshot 2>/dev/null | jq -r '
  .result.snapshot as $s
  | ($s.layouts[0].area // {width: 80, height: 24}) as $c
  | [([110, $c.width] | min), ([($s.agents | length) * 2 + 8, ($c.height * 0.8 | floor)] | min)]
  | @tsv' 2>/dev/null) || size=""

set --
if [ -n "$size" ]; then
  set -- --width "$(printf '%s' "$size" | cut -f1)" --height "$(printf '%s' "$size" | cut -f2)"
fi

exec "$herdr" plugin pane open \
  --plugin "${HERDR_PLUGIN_ID:-miguel.jev-focus}" \
  --entrypoint picker \
  --env "HJ_SOURCE_PANE_ID=${HERDR_PANE_ID:-}" \
  "$@"
