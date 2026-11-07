#!/usr/bin/env bash
# Build snpet.app out of the SwiftPM executable. SwiftPM makes a bare binary,
# and a desktop pet needs a bundle: Info.plist for LSUIElement and the icon,
# Resources for the sprite to live next to the binary. Output: .build/snpet.app
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$here"

swift build -c release --product snpet
bin="$(swift build -c release --show-bin-path)/snpet"

app="$here/.build/snpet.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/snpet"
cp Info.plist "$app/Contents/Info.plist"
cp Resources/miguel.gif "$app/Contents/Resources/"

# Icon: the sprite's first frame. Soft at 512px, but it is him.
work="$(mktemp -d)"
iconset="$work/snpet.iconset"
mkdir -p "$iconset"
sips -s format png Resources/miguel.gif --out "$work/base.png" >/dev/null
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$work/base.png" --out "$iconset/icon_${s}x${s}.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/snpet.icns"
rm -rf "$work"

# Ad-hoc signature: a stable identity, so Keychain and TCC remember the answer.
codesign --force --sign - "$app" >/dev/null
echo "built $app"
