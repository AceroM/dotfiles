#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")" && pwd -P)"
app="$HOME/Applications/Quick Record.app"
bundle_id="com.acerom.quickrecord"
# Chrome's native messaging host for chrome-extension/ (Quick Record HAR). The extension's
# manifest key pins its ID, so the host manifest can allow exactly that extension.
har_host_name="com.acerom.quickrecord.har"
har_extension_id="fgbibijbopkdcejhjmcpmleamodlfjpj"

cd "$project_dir"
/usr/bin/xcrun swift build -c release
bin_dir="$(/usr/bin/xcrun swift build -c release --show-bin-path)"
staged="$project_dir/.build/app/Quick Record.app"
mkdir -p "$staged/Contents/MacOS"
cp "$bin_dir/QuickRecord" "$staged/Contents/MacOS/QuickRecord"
cp "$bin_dir/QuickRecordHAR" "$staged/Contents/MacOS/QuickRecordHAR"
cp Info.plist "$staged/Contents/Info.plist"
# Nested code is signed before the bundle that contains it.
/usr/bin/codesign --force --sign "${QUICK_RECORD_SIGN_IDENTITY:--}" --identifier "$bundle_id.har" \
  "$staged/Contents/MacOS/QuickRecordHAR"
# Stable designated requirement helps local rebuilds retain the same app identity.
# Set QUICK_RECORD_SIGN_IDENTITY to a Developer ID identity if you have one.
/usr/bin/codesign --force --sign "${QUICK_RECORD_SIGN_IDENTITY:--}" \
  --identifier "$bundle_id" --requirements '=designated => identifier "com.acerom.quickrecord"' "$staged"
/usr/bin/codesign --verify --strict "$staged"

running_pid="$(/usr/bin/pgrep -x QuickRecord || true)"
if [[ -n "$running_pid" ]]; then
  status_file="$HOME/Library/Application Support/Quick Record/status.json"
  state="$(/usr/bin/plutil -extract state raw -o - "$status_file" 2>/dev/null || true)"
  if [[ "$state" != idle ]]; then
    echo "Quick Record is ${state:-running}. Stop recording or cancel selection before reinstalling."
    exit 1
  fi
  /usr/bin/open -g -a "$app" 'quickrecord://quit'
  for _ in {1..50}; do
    if ! /usr/bin/pgrep -x QuickRecord >/dev/null; then break; fi
    sleep 0.1
  done
  if /usr/bin/pgrep -x QuickRecord >/dev/null; then
    echo "Quick Record did not quit. Quit it from the menu bar before reinstalling."
    exit 1
  fi
fi
# Chrome's copy of the HAR host runs from inside the bundle; stop it before replacing the bundle.
# The extension reconnects on its own (a few seconds, at most a minute) and gets the new one.
/usr/bin/pkill -x QuickRecordHAR 2>/dev/null || true
mkdir -p "$HOME/Applications"
/usr/bin/ditto "$staged" "$app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"

# Match the existing GNU Stow layout without replacing any unrelated scripts.
mkdir -p "$HOME/Code/extensions"
for script in toggle-recording.sh record-last-region.sh; do
  source="$project_dir/../extensions/$script"
  target="$HOME/Code/extensions/$script"
  if [[ -e "$target" || -L "$target" ]]; then
    if [[ "$(readlink "$target" || true)" != "$source" ]] && ! [[ "$target" -ef "$source" ]]; then
      echo "Leaving existing $target untouched; add $source to Raycast manually."
    fi
  else
    ln -s "$source" "$target"
  fi
done
# Register the HAR host with every Chromium-family browser that's installed.
har_manifest="$(cat <<JSON
{
  "name": "$har_host_name",
  "description": "Quick Record HAR: saves a HAR beside Quick Record demo recordings",
  "path": "$app/Contents/MacOS/QuickRecordHAR",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$har_extension_id/"]
}
JSON
)"
registered=()
for browser_dir in "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Canary" "Chromium" \
                   "BraveSoftware/Brave-Browser" "net.imput.helium" "Arc/User Data"; do
  dir="$HOME/Library/Application Support/$browser_dir"
  [[ -d "$dir" ]] || continue
  mkdir -p "$dir/NativeMessagingHosts"
  printf '%s\n' "$har_manifest" > "$dir/NativeMessagingHosts/$har_host_name.json"
  registered+=("$browser_dir")
done

/usr/bin/open -g "$app"
echo "Installed $app"
echo "Raycast: Toggle Recording / Record Last Region"
if (( ${#registered[@]} )); then
  echo "HAR host registered for: ${registered[*]}"
  echo "Load the extension once per browser profile: chrome://extensions → Developer mode →"
  echo "  Load unpacked → $project_dir/chrome-extension (expected id $har_extension_id)"
fi
