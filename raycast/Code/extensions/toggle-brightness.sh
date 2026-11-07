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

PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# Default to the laptop; Option-minus passes external.
display_filter="${1:-builtin}"

lunar_bin="$(command -v lunar || true)"

if [[ -n "$lunar_bin" ]]; then
  lunar_command=("$lunar_bin")
elif [[ -x "/Applications/Lunar.app/Contents/MacOS/Lunar" ]]; then
  lunar_command=("/Applications/Lunar.app/Contents/MacOS/Lunar" @)
else
  echo "Lunar not found. Install it with: brew install --cask lunar"
  exit 1
fi

current_brightness="$(
  "${lunar_command[@]}" displays "$display_filter" brightness 2>/dev/null |
    awk '
      $1 == "brightness:" && $2 ~ /^[0-9]+([.][0-9]+)?$/ {
        if (!found || $2 > brightest) brightest = $2
        found = 1
      }
      END {
        if (found) print brightest
      }
    '
)"

if [[ ! "$current_brightness" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "Unable to read brightness from $display_filter displays"
  exit 1
fi

target_brightness="$(
  awk -v value="$current_brightness" \
    'BEGIN { print (value <= 0.5 ? "80" : "0") }'
)"

"${lunar_command[@]}" displays "$display_filter" brightness "$target_brightness" >/dev/null
