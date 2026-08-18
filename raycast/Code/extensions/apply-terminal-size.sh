#!/usr/bin/env bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Apply Terminal Size
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🖥️

# Documentation:
# @raycast.author AceroM
# @raycast.authorURL https://raycast.com/AceroM

set -euo pipefail

TERMINAL_WIDTH=1730
TERMINAL_HEIGHT=1083

window_json="$(yabai -m query --windows --window)"
display_index="$(printf '%s' "$window_json" | jq -r '.display')"
display_json="$(yabai -m query --displays --display "$display_index")"
display_id="$(printf '%s' "$display_json" | jq -r '.id')"

# NSScreen's visible frame excludes the menu bar and Dock.
visible_frame="$(osascript -l JavaScript - "$display_id" <<'JXA'
ObjC.import('AppKit');

function run(argv) {
  const displayID = Number(argv[0]);

  for (const screen of $.NSScreen.screens.js) {
    const screenNumber = Number(
      ObjC.unwrap(screen.deviceDescription.objectForKey('NSScreenNumber'))
    );

    if (screenNumber !== displayID) continue;

    const frame = screen.frame;
    const visible = screen.visibleFrame;

    return JSON.stringify({
      left: Number(visible.origin.x - frame.origin.x),
      top: Number(
        (frame.origin.y + frame.size.height) -
        (visible.origin.y + visible.size.height)
      ),
      width: Number(visible.size.width),
      height: Number(visible.size.height)
    });
  }

  throw new Error(`Display ${displayID} not found`);
}
JXA
)"

read -r grid_width grid_height x y < <(
  jq -nr \
    --argjson visible "$visible_frame" \
    --argjson width "$TERMINAL_WIDTH" \
    --argjson height "$TERMINAL_HEIGHT" \
    '[
      ($visible.width | floor),
      ($visible.height | floor),
      (($visible.width - $width) / 2 | floor),
      (($visible.height - $height) / 2 | floor)
    ] | @tsv'
)

yabai -m window --grid \
  "${grid_height}:${grid_width}:${x}:${y}:${TERMINAL_WIDTH}:${TERMINAL_HEIGHT}"
