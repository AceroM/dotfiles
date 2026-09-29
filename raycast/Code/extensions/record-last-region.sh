#!/usr/bin/env bash
# @raycast.schemaVersion 1
# @raycast.title Record Last Region
# @raycast.mode silent
# @raycast.icon ⏺️
# @raycast.packageName Quick Record
# @raycast.description Start recording the previous region immediately; run again to stop.

set -euo pipefail
app="$HOME/Applications/Quick Record.app"
if [[ ! -d "$app" ]]; then
  echo "Install Quick Record first: ~/.dotfiles/raycast/Code/quick-record/install.sh"
  exit 1
fi
exec /usr/bin/open -g -a "$app" 'quickrecord://last'
