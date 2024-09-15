# Editor used by CLI
export EDITOR="nvim"
export SUDO_EDITOR="nvim"
export BUN_INSTALL="$HOME/.bun"
export PATH="$HOME/.local/share/bob/nvim-bin:$HOME/.cargo/bin:$PATH:$BUN_INSTALL/bin:$PATH"

# pnpm
export PNPM_HOME="/home/miguel/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac

# rust
. "$HOME/.cargo/env"

# fzf
# determines search program for fzf
if type ag &> /dev/null; then
  export FZF_DEFAULT_COMMAND='ag -p ~/.gitignore -g ""'
fi
# prefer rg over ag
if type rg &> /dev/null; then
  export FZF_DEFAULT_COMMAND='rg --files --hidden'
fi

