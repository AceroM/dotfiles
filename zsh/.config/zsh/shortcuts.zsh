alias f="cat"
alias goo="goose"
alias rw="railway"
alias wr="wrangler"
alias wd="wrangler deploy"
alias b="bun"
alias n="nvim"
alias c="claude"
alias cs="claude --dangerously-skip-permissions"
alias ca="claude --permission-mode plan"
alias cx="codex --yolo"
alias pn="pnpm"
alias sp="git diff main --cached --name-only -z --diff-filter=ACMR | grep -z -E '\\.(ts|tsx|js|jsx|json|css|md)$' | xargs -0 bunx prettier --write && git diff main --cached --name-only -z --diff-filter=ACMR | grep -z -E '\\.(ts|tsx|js|jsx)$' | xargs -0 env NODE_OPTIONS=--max-old-space-size=8192 bunx eslint --fix"
alias y="yazi"
alias lg="lazygit"
alias ob="obsidian"
alias rs="openssl rand -base64 32"
alias ..='cd ..'
alias ...='cd ../..'

for i in 0 1 2 3 4 5 6 7 8 9; do
  eval "$i() { local p; p=\$(bm path $i) || { echo 'slot $i empty' >&2; return 1; }; cd \"\$p\"; }"
done
