# Herdr config helpers. Herdr is retired: Rex replaced it in Nov 2026 and its
# server stays stopped. The pane verbs that lived here (hd, hi, j/hr/hcap, hl,
# hls, hp, hs, hsend, hkeys, hrun, hwait, hx, hask, hspawn, hkill, ce) are in
# rex.zsh now, on Rex. What's left only touches Herdr's own config file, and
# nothing here runs herdr unless typed: no startup or chpwd hook, so a shell
# never starts the Herdr server by itself.

alias h="herdr"
alias eh="nvim ~/.config/herdr/config.toml"

# hc — push config.toml into the running server.
#
# The server parses config.toml once, at startup, and never looks at it again:
# a session that has been up for a week is still running whatever it read back
# then, so edits sit in the file changing nothing. Every edit ends here.
#
# Diagnostics come back as plain strings next to a status of
# applied/partial/failed — a partial reload keeps the old value for whatever it
# rejected, so they get printed. The silent case is a config that looks live
# and isn't. hrc is a second name for this one.
function hc() {
  # not "status": zsh keeps that one read-only as an alias for $?
  local out state
  out="$(herdr server reload-config 2>&1)" || { print -u2 -- "$out"; return 1 }

  state="$(print -r -- "$out" | jq -r '.result.status // empty' 2>/dev/null)"
  print -r -- "$out" | jq -r '.result.diagnostics[]?' 2>/dev/null |
    while IFS= read -r line; do print -u2 -- "  $line"; done

  case "$state" in
    applied) print -r -- "config reloaded" ;;
    partial) print -u2 -- "config partly reloaded — everything above kept its old value"; return 1 ;;
    "")      print -u2 -- "unexpected reply from herdr:"; print -u2 -- "$out"; return 1 ;;
    *)       print -u2 -- "config reload failed ($state)"; return 1 ;;
  esac
}
alias hrc="hc"
