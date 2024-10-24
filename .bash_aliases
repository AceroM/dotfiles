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
alias sc="xclip -selection c"
alias gc="xclip -selection c -o"
alias np="n package.json"
alias nv="n .env"
alias nr="n README.md"
alias fm="foreman"

# node
alias ns="npm start"
alias nd="npm run dev"
alias vr="npx vitest run"
alias b="bun"
alias bb="pnpm run baml-build"

# postgres
alias start_pg="sudo systemctl start postgresql.service"

# kamal
alias k="kamal"

# rails
alias bd="bundle"
alias os="clear && overmind start -f Procfile.dev"
alias oc="overmind connect web"
alias ng="n Gemfile"
alias fr="foreman start -f Procfile.dev \"css=1,guard=1,jobs=1\""
alias fb="foreman start -f Procfile.dev \"js=1,css=1,job=1\""

# doppler
alias dp="doppler"
