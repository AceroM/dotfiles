#!/bin/sh
# Build the GPUI app and install it as ~/Applications/Artifacts.app, so Spotlight, Raycast and
# Hammerspoon (Option-A) can launch it by bundle id. Rerun after changing the app.
set -eu

cd "$(dirname "$0")/.."
cargo build --release -p artifacts-app

app="$HOME/Applications/Artifacts.app"
mkdir -p "$app/Contents/MacOS"
# Copy then rename, so a running copy keeps its old binary (a new inode) instead of crashing;
# it picks up the new one on its next launch.
cp target/release/artifacts-app "$app/Contents/MacOS/.artifacts-app.new"
mv -f "$app/Contents/MacOS/.artifacts-app.new" "$app/Contents/MacOS/artifacts-app"
cat > "$app/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Artifacts</string>
  <key>CFBundleDisplayName</key><string>Artifacts</string>
  <key>CFBundleIdentifier</key><string>local.artifacts</string>
  <key>CFBundleExecutable</key><string>artifacts-app</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <!-- The pages come from the local server over plain http. -->
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
EOF
codesign --force --sign - "$app" >/dev/null 2>&1 || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
echo "installed $app"
