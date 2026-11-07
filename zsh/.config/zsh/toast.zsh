# toast.zsh — fire a top-right toast without stealing terminal focus.
#
# Routes through the `claudedone` hs.urlevent handler in
# ~/.hammerspoon/init.lua, which draws a non-activating hs.canvas. Using
# `open -g` keeps Hammerspoon in the background, so your terminal stays focused.
#
#   toast                       # "done"
#   toast build finished        # multi-word message
#   TOAST_TITLE="Deploy" toast shipped
#   TOAST_TIMEOUT=8 toast still running...

function _toast_urlencode() {
  emulate -L zsh
  unsetopt multibyte           # iterate bytes, so UTF-8 encodes as %E2%80%94 not %2014
  local str="$1" out="" i ch
  for (( i = 1; i <= ${#str}; i++ )); do
    ch="${str[i]}"
    case "$ch" in
      [a-zA-Z0-9.~_-]) out+="$ch" ;;
      *) out+=$(printf '%%%02X' "'$ch") ;;
    esac
  done
  printf '%s' "$out"
}

function toast() {
  emulate -L zsh
  local msg="${*:-done}"
  local title="${TOAST_TITLE:-Claude Code}"
  local timeout="${TOAST_TIMEOUT:-1.5}"

  open -g "hammerspoon://claudedone?msg=$(_toast_urlencode "$msg")&title=$(_toast_urlencode "$title")&timeout=$(_toast_urlencode "$timeout")"
}
