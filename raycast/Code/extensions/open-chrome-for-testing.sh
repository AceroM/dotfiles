#!/usr/bin/env -S LC_ALL=en_US.UTF-8 bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Open Chrome for Testing
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🧪
# @raycast.packageName Browsers

# Documentation:
# @raycast.author AceroM
# @raycast.authorURL https://raycast.com/AceroM
# @raycast.description Brings the running Google Chrome for Testing to the front (launches the newest cached build if none is running)

set -uo pipefail

# Main browser process only: helpers live under Contents/Frameworks, so match the MacOS binary path.
running="$(ps -axo comm= | grep -F 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' | head -n 1)"

if [[ -n "$running" ]]; then
  app="${running%/Contents/MacOS/*}"
  open -a "$app"
  echo "Focused $(basename "$(dirname "$(dirname "$app")")")"
  exit 0
fi

newest() {
  ls -d "$@" 2>/dev/null | sort -V | tail -n 1
}

# Nothing running: fall back to launching the newest cached build (puppeteer first, then Playwright).
app="$(newest "$HOME"/.cache/puppeteer/chrome/*/chrome-mac-*/"Google Chrome for Testing.app")"
[[ -n "$app" ]] || app="$(newest "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac-*/"Google Chrome for Testing.app")"

if [[ -z "$app" ]]; then
  echo "Google Chrome for Testing is not running and no cached build was found"
  exit 1
fi

open -a "$app"
echo "Launched $(basename "$(dirname "$(dirname "$app")")")"
