# directories
alias pr="cd packages/core"
alias pf="cd packages/functions"
alias fe="cd packages/frontend"
alias ze="cd packages/zero"
alias be="cd packages/backend"
alias au="cd packages/auth"
alias pd="cd packages/demo"
alias sc="cd packages/scripts"
alias f="n \$(fzf)"
alias o="n ."
alias eb="n ~/.bashrc"
alias ek="n ~/.config/kitty/kitty.conf"
alias eg="n ~/.config/ghostty/config"
alias nl="nvim -c':e#<1'"
alias nc="npm run console"
alias en="cd ~/dotfiles/.config/nvim"
alias ec="cd ~/dotfiles/.config/nvim && n lua/plugins/completions.lua"
alias ds="npm run db:studio"

# quick commands
alias l="printf '\033[2J\033[3J\033[1;1H'"
alias lc="litecli"
alias pc="pgcli"
alias y="yazi"
alias sb="source ~/.bashrc"
alias lg="lazygit"
alias gd="g add -A && g di HEAD"
alias ld="lazydocker"
alias sc="xclip -selection c"
alias gc="xclip -selection c -o"
alias np="n package.json"
alias nv="n .env"
alias nr="n README.md"
alias fm="foreman"
alias st="bunx sst"

# node
alias ns="npm start"
alias nd="npm run dev"
alias dd="doppler run -- npm run dev"
alias vr="npx vitest run"
alias b="bun"
alias d="bun run dev"
alias dp="doppler"
alias p="bun run push"
alias pp="bun run push-prod"
alias u="bun run db-up"
alias s="bun run build-schema"
alias sd="bun run build-schema"
alias se="bun seed"
alias sp="bun run seed-prod"
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
# alias dp="doppler"

# cloudflare
alias cf="cloudflared"
alias cl="claude"
