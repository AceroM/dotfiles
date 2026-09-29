#!/bin/sh
set -eu

case "${1:-}" in
  agents|spaces) ;;
  *) echo "usage: open.sh agents|spaces" >&2; exit 2 ;;
esac

herdr="${HERDR_BIN_PATH:-$HOME/.local/bin/herdr}"

# Toggle: the open picker records "pid mode" here. The same key closes it; the
# other picker's key swaps it out.
pidfile="$HOME/.cache/herdr-quick-picker.pid"
if [ -r "$pidfile" ]; then
  read -r pid open_mode < "$pidfile" || true
  if [ -n "${pid:-}" ] && kill -TERM "$pid" 2>/dev/null; then
    [ "${open_mode:-}" = "$1" ] && exit 0
    # Herdr allows one popup at a time; let the old one close first.
    i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 20 ]; do sleep 0.01; i=$((i + 1)); done
  fi
fi

# Fallback path: Hammerspoon (herdrkeys.lua) normally handles these keys itself.
# ~300px wide at font-size 14; tall enough for every entry plus the header,
# footer, and popup frame, capped at 80% of the client.
max_width=40
case "$1" in
  agents) filter='.agents | length' ;;
  spaces) filter='.workspaces | length' ;;
esac
snapshot=$("$herdr" api snapshot 2>/dev/null) || snapshot=""
size=$(printf '%s' "$snapshot" | /usr/bin/jq -r --argjson w "$max_width" "
  .result.snapshot as \$s
  | (\$s.layouts[0].area // {width: 80, height: 24}) as \$c
  | [([\$w, \$c.width] | min), ([(\$s | $filter) + 7, (\$c.height * 0.8 | floor)] | min)]
  | @tsv" 2>/dev/null) || size=""

if [ -n "$size" ]; then
  # Parameter expansion, not cut: every spawned process costs ~20ms here.
  set -- "$1" --width "${size%%	*}" --height "${size##*	}" --env "QP_SNAPSHOT=$snapshot"
fi

exec "$herdr" plugin pane open \
  --plugin "${HERDR_PLUGIN_ID:-miguel.quick-pickers}" \
  --entrypoint "$@"
