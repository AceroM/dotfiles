# fnm disabled — ~/.vite-plus/bin/node sits ahead of fnm on PATH, so fnm's
# per-cd switch ("Using Node vX") never changed which node ran; it only cost
# ~13ms at startup and ~9ms per cd. Uncomment to bring it back.
# if command -v fnm >/dev/null 2>&1; then
#   eval "$(fnm env --use-on-cd --log-level=quiet --shell zsh)"
# fi
