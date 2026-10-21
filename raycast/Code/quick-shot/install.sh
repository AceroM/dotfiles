#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")" && pwd -P)"
app="$HOME/Applications/Quick Shot.app"
bundle_id="com.acerom.quickshot"

cd "$project_dir"
/usr/bin/xcrun swift build -c release
bin_dir="$(/usr/bin/xcrun swift build -c release --show-bin-path)"
staged="$project_dir/.build/app/Quick Shot.app"
mkdir -p "$staged/Contents/MacOS"
cp "$bin_dir/QuickShot" "$staged/Contents/MacOS/QuickShot"
cp Info.plist "$staged/Contents/Info.plist"
# Stable designated requirement helps local rebuilds retain Screen Recording permission.
/usr/bin/codesign --force --sign "${QUICK_SHOT_SIGN_IDENTITY:--}" \
  --identifier "$bundle_id" --requirements '=designated => identifier "com.acerom.quickshot"' "$staged"
/usr/bin/codesign --verify --strict "$staged"

if /usr/bin/pgrep -x QuickShot >/dev/null; then
  /usr/bin/open -g -a "$app" 'quickshot://quit'
  for _ in {1..50}; do
    if ! /usr/bin/pgrep -x QuickShot >/dev/null; then break; fi
    sleep 0.1
  done
  /usr/bin/pkill -x QuickShot || true
fi
if /usr/bin/pgrep -x Shottr >/dev/null; then
  echo "Shottr is running and may hold ⌘⇧1 / ⌘⇧2. Quit it (and remove it from Login Items)."
fi
mkdir -p "$HOME/Applications"
/usr/bin/ditto "$staged" "$app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
/usr/bin/open -g "$app"
echo "Installed $app"
