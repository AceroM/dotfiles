#!/bin/sh
# Rebuild the locally patched, pinned Herdr. This does not replace a live server.
set -eu
plugin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_dir=${HERDR_LINKS_SOURCE_DIR:-"$HOME/Code/herdr-custom"}
base=b99002ac99b09e00b4ca692436cb15a6b0d676f1
if [ ! -d "$source_dir/.git" ]; then
  git clone --depth 1 --branch v0.9.0 https://github.com/herdrdev/herdr.git "$source_dir"
fi
if [ "$(git -C "$source_dir" rev-parse HEAD)" != "$base" ]; then
  echo "Expected Herdr v0.9.0 ($base); inspect the source checkout before rebuilding." >&2
  exit 1
fi
if ! git -C "$source_dir" apply --reverse --check "$plugin_dir/file-links-v0.9.0.patch" 2>/dev/null; then
  git -C "$source_dir" apply --check "$plugin_dir/file-links-v0.9.0.patch"
  git -C "$source_dir" apply "$plugin_dir/file-links-v0.9.0.patch"
fi
if [ -z "${ZIG:-}" ] && ! command -v zig >/dev/null 2>&1; then
  ZIG="$HOME/.local/share/herdr-build-tools/zig-aarch64-macos-0.15.2/zig"
  export ZIG
fi
cd "$source_dir"
cargo build --release --locked
echo "Built $source_dir/target/release/herdr"
