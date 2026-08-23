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
  "${lunar_command[@]}" displays main brightness 2>/dev/null |
    awk '
      $1 == "brightness:" {
        print $2
        exit
      }
    '
)"

if [[ ! "$current_brightness" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "Unable to read the main display brightness"
  exit 1
fi

target_brightness="$(
  awk -v value="$current_brightness" \
    'BEGIN { print (value <= 0.5 ? "80" : "0") }'
)"

"${lunar_command[@]}" displays main brightness "$target_brightness" >/dev/null
