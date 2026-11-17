#!/usr/bin/env bash
set -euo pipefail

project="$(cd "$(dirname "$0")" && pwd -P)"
domain="gui/$(id -u)"
label="com.acerom.memoryguard"
app="$HOME/Applications/Memory Guard.app"
agent="$HOME/Library/LaunchAgents/$label.plist"

if [[ "$(id -u)" == 0 ]] || ! /bin/launchctl print "$domain" >/dev/null 2>&1; then
  echo "Install Memory Guard as the user signed in to the macOS desktop." >&2
  exit 1
fi

/usr/bin/xcrun swift build --package-path "$project" -c release
bin_dir="$(/usr/bin/xcrun swift build --package-path "$project" -c release --show-bin-path)"
stage="$(mktemp -d "$project/.build/memory-guard-install.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
bundle="$stage/Memory Guard.app"
mkdir -p "$bundle/Contents/MacOS"
cp "$bin_dir/MemoryGuard" "$bundle/Contents/MacOS/"
cp "$project/Info.plist" "$bundle/Contents/"
/usr/bin/codesign --force --sign - "$bundle"
/usr/bin/codesign --verify --strict "$bundle"

job="$stage/launch-agent.plist"
/usr/bin/plutil -create xml1 "$job"
/usr/bin/plutil -insert Label -string "$label" "$job"
/usr/bin/plutil -insert ProgramArguments -json '[]' "$job"
/usr/bin/plutil -insert ProgramArguments.0 -string "$app/Contents/MacOS/MemoryGuard" "$job"
/usr/bin/plutil -insert LimitLoadToSessionType -string Aqua "$job"
/usr/bin/plutil -insert RunAtLoad -bool YES "$job"
/usr/bin/plutil -insert KeepAlive -json '{"SuccessfulExit":false}' "$job"
/usr/bin/plutil -lint "$bundle/Contents/Info.plist" "$job"

if [[ -e "$app" ]]; then
  installed_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw "$app/Contents/Info.plist")"
  if [[ "$installed_id" != "$label" ]]; then
    echo "Another application already exists at $app" >&2
    exit 1
  fi
fi
if /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then
  /bin/launchctl bootout "$domain/$label"
fi
mkdir -p "$HOME/Applications" "$HOME/Library/LaunchAgents"
/usr/bin/ditto "$bundle" "$app"
/usr/bin/install -m 644 "$job" "$agent"
/bin/launchctl bootstrap "$domain" "$agent"

# Preserve the existing instructions and their backing files, including symlinks.
for instructions in "$HOME/.codex/AGENTS.md" "$HOME/.claude/CLAUDE.md"; do
  mkdir -p "$(dirname "$instructions")"
  if [[ ! -f "$instructions" ]] || ! /usr/bin/grep -Fqx '## Memory Guard on macOS' "$instructions"; then
    if [[ -s "$instructions" ]]; then printf '\n' >> "$instructions"; fi
    cat "$project/agent-instructions.md" >> "$instructions"
  fi
done

echo "Installed and started $app"
