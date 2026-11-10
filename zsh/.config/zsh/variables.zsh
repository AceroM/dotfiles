PATH="$PATH:/Applications/WezTerm.app/Contents/MacOS"
# Exported so child processes (Claude Code / Codex ctrl+g, git) see them;
# Claude Code checks VISUAL first, then EDITOR.
export EDITOR="nvim"
export VISUAL="nvim"
# Pin emacs keys. zsh picks vi mode by itself when EDITOR/VISUAL contain "vi"
# at startup, so any shell that inherits the export above (every Herdr pane,
# once the server was started from a shell) loses alt+backspace, ctrl+a/e, etc.
bindkey -e
DROP_TABLES_SQL="DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Shared adjective/noun pools for tmux/Claude session names.
typeset -ga SESSION_NAME_ADJECTIVES=(
  amber brave calm dapper eager fabled gentle hardy icy jaunty keen lucid
  misty noble odd plucky quick radiant sunny tidy upbeat vivid witty xtra
  young zesty
)

typeset -ga SESSION_NAME_NOUNS=(
  anchor beacon citadel dragon ember falcon grove harbor island junction
  kingdom lantern meadow nebula oasis prairie quarry rocket summit temple
  urchin valley workshop xenon yard zephyr
)
