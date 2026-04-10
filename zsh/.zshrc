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
