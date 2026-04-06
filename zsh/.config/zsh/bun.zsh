alias bu="bun update --interactive"
alias ct="bun check-types"

export BUN_INSTALL="$HOME/.bun"
export DELTA_FEATURES=+side-by-side
export PATH="$BUN_INSTALL/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"
export TIMEOUT=9999999

# completions
[ -s "/Users/miguelacero/.bun/_bun" ] && source "/Users/miguelacero/.bun/_bun"
