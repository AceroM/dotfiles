#!/usr/bin/env bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Toggle Brightness
# @raycast.mode silent

# Optional parameters:
# @raycast.icon ☀️

# Documentation:
# @raycast.author AceroM
# @raycast.authorURL https://raycast.com/AceroM

set -euo pipefail

PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

brightness_bin="$(command -v brightness || true)"

if [[ -z "$brightness_bin" ]]; then
  echo "brightness not found. Install it with: brew install brightness"
  exit 1
fi

brightness_output="$("$brightness_bin" -l 2>/dev/null)"
main_display="$(
  printf '%s\n' "$brightness_output" |
    awk '$1 == "display" && $3 ~ /^main,?$/ {
      sub(/:$/, "", $2)
      print $2
      exit
    }'
)"

if [[ -z "$main_display" ]]; then
  echo "Unable to find the main display"
  exit 1
fi

current_brightness="$(
  printf '%s\n' "$brightness_output" |
    awk -v target="$main_display" '
      $1 == "display" && $3 == "brightness" {
        sub(/:$/, "", $2)
        if ($2 == target) {
          print $4
          exit
        }
      }'
)"

if [[ ! "$current_brightness" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "Unable to read the main display brightness"
  exit 1
fi

target_brightness="$(
  awk -v current="$current_brightness" \
    'BEGIN { print current <= 0.001 ? "0.8" : "0" }'
)"

"$brightness_bin" -m "$target_brightness"
