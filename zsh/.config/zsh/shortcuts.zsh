alias f="cat"
alias goo="goose"
alias rw="railway"
alias wr="wrangler"
alias wd="wrangler deploy"
alias b="bun"
alias n="nvim"
alias nl="NVIM_NO_LSP=1 nvim" # open without any LSP (see nvim options.lua)
alias c="claude"
alias cs="claude --dangerously-skip-permissions"
alias ca="claude --permission-mode plan"
alias cx="codex --yolo"
alias pn="pnpm"
alias sp="git diff main --cached --name-only -z --diff-filter=ACMR | grep -z -E '\\.(ts|tsx|js|jsx|json|css|md)$' | xargs -0 bunx prettier --write && git diff main --cached --name-only -z --diff-filter=ACMR | grep -z -E '\\.(ts|tsx|js|jsx)$' | xargs -0 env NODE_OPTIONS=--max-old-space-size=8192 bunx eslint --fix"
alias y="yazi"
alias lg="lazygit"
alias ob="obsidian"
alias rnd="openssl rand -base64 32"
alias kc='pkill -i "Google Chrome"; pkill -i "chrome"; echo "Done"'

unalias rs 2>/dev/null
rs() {
  local db="${1:?usage: rs <database>}"
  psql "$db" -c "$DROP_TABLES_SQL"
}
alias ..='cd ..'
alias ...='cd ../..'

for i in 0 1 2 3 4 5 6 7 8 9; do
  unalias "$i" 2>/dev/null  # avoid "defining function based on alias" on re-source
  eval "$i() { local p; p=\$(bm path $i) || { echo 'slot $i empty' >&2; return 1; }; cd \"\$p\"; }"
  # <i>p: jump to slot <i>, then launch a Claude session there (p, defined in claude.zsh)
  eval "${i}p() { $i && p \"\$@\"; }"
done
