# Prompt
#
# macOS ships the default zsh prompt "%n@%m %1~ %# " (set in /etc/zshrc), e.g.
#   miguel@Mac .dotfiles %
# We redefine it here only to add a left indent on the prompt line. This is the
# shell-side answer to "pad only the prompt, not the whole Ghostty window":
# Ghostty's window-padding-x pads everything, so the indent lives here instead.
#
# Note: the leading spaces indent the prompt line and what you type, but NOT
# command output (that still starts at the window's left edge). Tweak the count
# of leading spaces below to taste.
PROMPT='%n@%m %1~ %# '
