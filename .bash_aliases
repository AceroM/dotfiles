# directories
alias pr="cd packages/core"
alias pf="cd packages/functions"
alias fe="cd packages/frontend"
alias pd="cd packages/demo"
alias sc="cd packages/scripts"
alias f="n \$(fzf)"
alias o="n ."
alias eb="n ~/.bashrc"
alias ek="n ~/.config/kitty/kitty.conf"
alias nl="nvim -c':e#<1'"
alias en="cd ~/dotfiles/.config/nvim"
alias ec="cd ~/dotfiles/.config/nvim && n lua/plugins/completions.lua"

# quick commands
alias l="printf '\033[2J\033[3J\033[1;1H'"
alias lc="litecli"
alias pc="pgcli"
alias y="yazi"
alias sb="source ~/.bashrc"
alias lg="lazygit"
alias ld="lazydocker"
alias set_clip="xclip -selection c"
alias get_clip="xclip -selection c -o"
alias np="n package.json"
alias nv="n .env"
alias nr="n README.md"
alias fm="foreman"

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
alias b="bun"

# postgres
alias start_pg="sudo systemctl start postgresql.service"

# kamal
alias k="kamal"

# rails
alias bd="bundle"
alias os="clear && overmind start -f Procfile.dev"
alias oc="overmind connect web"
alias ng="n Gemfile"

# doppler
alias dp="doppler"
