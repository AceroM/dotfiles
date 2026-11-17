#!/usr/bin/env bash
# The Go CLI only needs the Rust renderer for a screen or the theme catalog.
set -euo pipefail
app_dir="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bin="$app_dir/target/release/jv"
if [[ ! -x "$bin" ]] || [[ -n "$(find -L "$app_dir/src" "$app_dir/Cargo.toml" "$app_dir/Cargo.lock" -newer "$bin" -print -quit)" ]]; then
  command -v cargo >/dev/null || { printf '%s\n' 'jv: Cargo is required to build the viewer (https://rustup.rs).' >&2; exit 1; }
  printf '%s\n' 'jv: building the viewer…' >&2
  cargo build --release --locked --quiet --manifest-path "$app_dir/Cargo.toml" --target-dir "$app_dir/target" >&2
fi
exec "$bin" "$@"
