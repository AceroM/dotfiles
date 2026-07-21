alias ag="agent-browser --cdp http://localhost:9222"

agent-browser-local() {
  local chrome="$HOME/.agent-browser/browsers/chrome-150.0.7871.46/chrome"
  local libs="$HOME/.local/lib/chrome-deps/usr/lib/x86_64-linux-gnu"

  LD_LIBRARY_PATH="$libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    command agent-browser "$@" \
      --executable-path "$chrome" \
      --args "--no-sandbox,--disable-setuid-sandbox"
}

alias agb="agent-browser-local"
export PATH="$HOME/.browser-use/bin:$HOME/.browser-use-env/bin:$PATH"
