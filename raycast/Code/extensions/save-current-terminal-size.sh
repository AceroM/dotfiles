#!/usr/bin/env bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Save Current Terminal Size
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 💾

# Documentation:
# @raycast.author AceroM
# @raycast.authorURL https://raycast.com/AceroM

set -euo pipefail

TARGET="$HOME/.dotfiles/raycast/Code/extensions/apply-terminal-size.sh"

window_json="$(yabai -m query --windows --window)"
app="$(printf '%s' "$window_json" | jq -r '.app // empty')"

if [[ "$app" != "Ghostty" ]]; then
  echo "Focused window is ${app:-unknown}, not Ghostty"
  exit 1
fi

w="$(printf '%s' "$window_json" | jq -r '.frame.w | floor')"
h="$(printf '%s' "$window_json" | jq -r '.frame.h | floor')"

if [[ ! "$w" =~ ^[0-9]+$ || ! "$h" =~ ^[0-9]+$ ]]; then
  echo "Failed to read focused window size"
  exit 1
fi

if [[ ! -f "$TARGET" ]]; then
  echo "Apply script not found: $TARGET"
  exit 1
fi

if ! grep -Eq '^TERMINAL_WIDTH=[0-9]+$' "$TARGET" ||
  ! grep -Eq '^TERMINAL_HEIGHT=[0-9]+$' "$TARGET"; then
  echo "Terminal size settings not found in $TARGET"
  exit 1
fi

perl -0777 -i -pe \
  "s|TERMINAL_WIDTH=\\d+|TERMINAL_WIDTH=${w}|; s|TERMINAL_HEIGHT=\\d+|TERMINAL_HEIGHT=${h}|" \
  "$TARGET"
