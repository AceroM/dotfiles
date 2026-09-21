#!/usr/bin/env bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Toggle Herdr Sounds
# @raycast.mode compact

# Optional parameters:
# @raycast.icon 🔊
# @raycast.packageName Herdr

# Documentation:
# @raycast.author AceroM
# @raycast.authorURL https://raycast.com/AceroM
# @raycast.description Toggle sounds for background agent state changes and reload Herdr's configuration.

set -euo pipefail

PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

herdr_bin="$(command -v herdr || true)"
if [[ ! -x "$herdr_bin" ]]; then
  echo "Herdr CLI not found"
  exit 1
fi

config="${HERDR_CONFIG_PATH:-$HOME/.config/herdr/config.toml}"
if [[ ! -f "$config" ]]; then
  echo "Herdr config not found: $config"
  exit 1
fi

# A missing setting uses Herdr's default, which is enabled.
current="$(
  awk '
    /^[[:space:]]*\[[^]]+\][[:space:]]*$/ {
      in_sound = ($0 ~ /^[[:space:]]*\[ui\.sound\][[:space:]]*$/)
    }
    in_sound && /^[[:space:]]*enabled[[:space:]]*=/ {
      value = $0
      sub(/^[^=]*=[[:space:]]*/, "", value)
      sub(/[[:space:]]*(#.*)?$/, "", value)
      print value
      exit
    }
  ' "$config"
)"

if [[ -z "$current" ]]; then
  current="true"
fi

case "$current" in
  true) target="false"; label="off" ;;
  false) target="true"; label="on" ;;
  *) echo "Invalid ui.sound.enabled value: $current"; exit 1 ;;
esac

config_dir="$(cd "$(dirname "$config")" && pwd -P)"
tmp="$(mktemp "$config_dir/.config.toml.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

awk -v target="$target" '
  function is_section(line) {
    return line ~ /^[[:space:]]*\[[^]]+\][[:space:]]*$/
  }

  {
    if ($0 ~ /^[[:space:]]*\[ui\.sound\][[:space:]]*$/) {
      in_sound = 1
      saw_sound = 1
      print
      next
    }

    if (is_section($0)) {
      if (in_sound && !wrote_enabled) {
        print "enabled = " target
        wrote_enabled = 1
      }
      in_sound = 0
    }

    if (in_sound && $0 ~ /^[[:space:]]*enabled[[:space:]]*=/) {
      print "enabled = " target
      wrote_enabled = 1
      next
    }

    print
  }

  END {
    if (!saw_sound) {
      print ""
      print "[ui.sound]"
      print "enabled = " target
    } else if (in_sound && !wrote_enabled) {
      print "enabled = " target
    }
  }
' "$config" >"$tmp"

if ! HERDR_CONFIG_PATH="$tmp" "$herdr_bin" config check >/dev/null; then
  echo "Herdr rejected the updated config"
  exit 1
fi

# Copy through a stowed symlink rather than replacing the symlink itself.
cp "$tmp" "$config"

if "$herdr_bin" server reload-config >/dev/null 2>&1; then
  echo "Herdr sounds $label"
else
  echo "Herdr sounds $label (applies next launch)"
fi
