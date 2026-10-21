# Full compinit audit at most once a day; otherwise trust the cached dump.
autoload -Uz compinit
() {
  setopt local_options extended_glob
  if [[ -n ${ZDOTDIR:-$HOME}/.zcompdump(#qN.mh+24) ]]; then compinit; else compinit -C; fi
}

for file in ~/.config/zsh/*.zsh; do
  source "$file"
done

alias ez="nvim ~/.zshrc"
alias sz="source ~/.zshrc"
if [ -f ~/.zsh_private ]; then
  source ~/.zsh_private
fi

# sentry
fpath=("/Users/miguelacero/.local/share/zsh/site-functions" $fpath)

# bun completions
[ -s "/Users/miguel/.bun/_bun" ] && source "/Users/miguel/.bun/_bun"

# direnv disabled — no .envrc has ever been allowed, and the hook ran on every
# prompt and twice per cd. Uncomment if you start using .envrc files.
# eval "$(direnv hook zsh)"

[ -f "$HOME/.config/cloudflare/wrangler.env" ] && . "$HOME/.config/cloudflare/wrangler.env"

# >>> Codex installer >>>
export PATH="$HOME/.local/bin:$PATH"
# <<< Codex installer <<<
