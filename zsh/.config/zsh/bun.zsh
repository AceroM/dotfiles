alias bu="bun update --interactive"
alias bd="bun run deploy"
alias ct="bun check-types"
alias rd="bun db:reset && bun run dev"
alias tm="bun t:dev"
alias td="bun db:reset && bun run t:dev"
alias bt="bun t:dev"

export BUN_INSTALL="$HOME/.bun"
export DELTA_FEATURES=+side-by-side
export PATH="$BUN_INSTALL/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"
export TIMEOUT=9999999

# completions
[ -s "/Users/miguelacero/.bun/_bun" ] && source "/Users/miguelacero/.bun/_bun"
