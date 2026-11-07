#!/usr/bin/env bash
# @raycast.schemaVersion 1
# @raycast.title Toggle Recording
# @raycast.mode silent
# @raycast.icon ⏺️
# @raycast.packageName Quick Record
# @raycast.description Click a window or hold and drag a region to record; run again to stop and save.

set -euo pipefail
app="$HOME/Applications/Quick Record.app"
if [[ ! -d "$app" ]]; then
  echo "Install Quick Record first: ~/.dotfiles/raycast/Code/quick-record/install.sh"
  exit 1
fi
exec /usr/bin/open -g -a "$app" 'quickrecord://toggle'
