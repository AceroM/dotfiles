# directories
alias pc="cd packages/core"
alias pf="cd packages/functions"
alias fe="cd packages/frontend"
alias pd="cd packages/demo"
alias sc="cd packages/scripts"
alias f="n \$(fzf)"
alias eb="n ~/.bashrc"
alias ek="n ~/.config/kitty/kitty.conf"
alias en="cd ~/dotfiles/.config/nvim"
alias ec="cd ~/dotfiles/.config/nvim && n lua/plugins/completions.lua"

# quick commands
alias l="clear"
alias y="yazi"
alias sb="source ~/.bashrc"
alias lg="lazygit"
alias ld="lazydocker"
alias set_clip="xclip -selection c"
alias get_clip="xclip -selection c -o"
alias np="n package.json"
alias ng="n .gitignore"
alias nv="n .env"
alias nr="n README.md"

# git
alias gco="git checkout"
alias gst="git status"
alias gl="git pull"
alias gcl="git clone"
alias gpo="git push --set-upstream origin"

# node
alias ns="npm start"
alias nd="npm run dev"
alias vr="npx vitest run"
alias kml="doppler run -- npx knex migrate:list"
alias kmu="doppler run -- npx knex migrate:up"
alias kmd="doppler run -- npx knex migrate:down"
alias nsg="npx sst secret get"
alias nss="npx sst secret set"
alias nsl="npx sst secret list"
alias nsd="npx sst deploy"

# rails
alias bi="bundle i"
alias ba="bundle add"
alias os="clear && overmind start -f Procfile.dev"
alias oc="overmind connect web"

# doppler
alias dr="doppler run"
alias ds="doppler secrets"
alias dp="doppler setup"
alias dsg="doppler secrets get"
alias dss="doppler secrets set"
