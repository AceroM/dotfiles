# Prompt
#
# Toggle by swapping which PROMPT line is commented out, then `sz`.
# macOS's default ("%n@%m %1~ %# ", set in /etc/zshrc) shows user@host dir %.
# The "Last login: ..." banner is silenced by ~/.hushlogin (zsh/.hushlogin).

PROMPT='❯ '

# "go ❯ ": last path component (~ at home; %~ for the full ~/path) + ❯ (U+276F,
# single-width, unlike ▶ → λ which are East Asian ambiguous width).
# PROMPT='%1~ ❯ '
