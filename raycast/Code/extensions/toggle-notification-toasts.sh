#!/usr/bin/env bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Toggle Notification Toasts
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🔕
# @raycast.packageName Hammerspoon

# Documentation:
# @raycast.author AceroM
# @raycast.authorURL https://raycast.com/AceroM
# @raycast.description Mute/unmute the centered Slack cards Hammerspoon draws. Muted only hides the cards — the notifications keep landing in the `sn` feed.

set -euo pipefail

PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

hs_bin="$(command -v hs || true)"
if [[ ! -x "$hs_bin" ]]; then
  hs_bin="/Applications/Hammerspoon.app/Contents/Frameworks/hs/hs"
fi

if [[ ! -x "$hs_bin" ]]; then
  echo "Hammerspoon CLI not found — install it with hs.ipc.cliInstall()"
  exit 1
fi

# Prints "true" (now muted) or "false" (now toasting); anything else means the
# module never loaded, so don't report a state we didn't actually set.
state="$("$hs_bin" -c "notifications.toggleMuted()" 2>&1 | tail -n 1)"

case "$state" in
  true)  echo "Notification toasts muted — still recording to the sn feed" ;;
  false) echo "Notification toasts on" ;;
  *)     echo "Could not reach Hammerspoon: ${state:-no response}"; exit 1 ;;
esac
