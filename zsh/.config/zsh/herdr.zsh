# Herdr helpers — address panes by name, talk between them, scrape their output.
#
# Herdr's own CLI is complete but addresses panes by opaque IDs (w1:p5) and
# returns JSON. These wrappers add: name-based targeting, tmux-style
# capture/send verbs, and a real request/response call between panes (hx).
#
#   hls                    list panes            hsend <t> <text>  type text, no Enter
#   hid <t>                resolve a target      hkeys <t> <key>   send key presses
#   hname [<t>] <name>     label a pane          hrun  <t> <cmd>   type cmd + Enter
#   hspawn <name> [cmd]    new labeled pane      hcap  <t> [n]     capture output
#   hkill <t>              close a pane          hwait <t> <pat>   wait for output
#   hx   <t> <cmd>         run + capture stdout/stderr + exit code
#   hask <agent> <prompt>  prompt an agent, wait, print its reply
#
# <target> is a pane label, an agent name, a pane ID (w1:p5), or empty/"." for
# the calling pane. Everything requires running inside Herdr (HERDR_ENV=1).

# stale aliases from older versions of this file shadow the functions below
unalias hls hid hname hsend hkeys hrun hcap hwait hx hask hspawn hkill 2>/dev/null

alias h="herdr"
alias hr="herdr server reload-config"
alias eh="nvim ~/.config/herdr/config.toml"

function _h_guard() {
  if [[ "${HERDR_ENV:-}" != 1 ]]; then
    print -u2 "not inside a Herdr pane (HERDR_ENV unset)"
    return 1
  fi
}

# resolve a target to a pane ID: empty/"."/"self" -> calling pane, w1:p5 -> literal,
# otherwise match a pane label, then a live agent name. Ambiguity is an error
# rather than a coin flip, since the next command would mutate the wrong pane.
function _h_id() {
  local target="${1:-}"
  _h_guard || return 1

  if [[ -z "$target" || "$target" == "." || "$target" == self ]]; then
    print -r -- "$HERDR_PANE_ID"
    return 0
  fi
  # IDs are alphanumeric, not just digits — herdr continues p9 -> pA -> pB
  if [[ "$target" =~ '^w[0-9A-Za-z]+:p[0-9A-Za-z]+$' ]]; then
    print -r -- "$target"
    return 0
  fi

  local json matches
  json="$(herdr pane list 2>/dev/null)" || { print -u2 "herdr pane list failed"; return 1 }
  matches="$(print -r -- "$json" |
    jq -r --arg t "$target" '.result.panes[] | select(.label == $t or .agent == $t) | .pane_id')"

  case "${(w)#matches}" in
    0) print -u2 "no pane named '$target'"; return 1 ;;
    1) print -r -- "$matches" ;;
    *) print -u2 "'$target' matches several panes: ${matches//$'\n'/ }"; return 1 ;;
  esac
}

function hid() { _h_id "$@" }

# panes as a table: id, label/agent, status, cwd. * marks the calling pane.
function hls() {
  _h_guard || return 1
  herdr pane list 2>/dev/null | jq -r --arg self "$HERDR_PANE_ID" '
    .result.panes[]
    | [ (if .pane_id == $self then "*" else " " end),
        .pane_id,
        (.label // .agent // "-"),
        (.agent_status // "-"),
        (.cwd // "-") ]
    | @tsv' | column -t -s $'\t'
}

# label the calling pane, or another one: hname build   /   hname w1:p5 build
function hname() {
  local target name
  if (( $# >= 2 )); then target="$1"; name="$2"; else target=""; name="$1"; fi
  [[ -n "$name" ]] || { print -u2 "usage: hname [<target>] <name>"; return 1 }
  local id; id="$(_h_id "$target")" || return 1
  herdr pane rename "$id" "$name" >/dev/null || return 1
  print -r -- "$id -> $name"
}

function hsend() {
  local target="$1"; shift
  local id; id="$(_h_id "$target")" || return 1
  herdr pane send-text "$id" "$*"
}

function hkeys() {
  local target="$1"; shift
  local id; id="$(_h_id "$target")" || return 1
  herdr pane send-keys "$id" "$@"
}

function hrun() {
  local target="$1"; shift
  local id; id="$(_h_id "$target")" || return 1
  herdr pane run "$id" "$*"
}

# capture-pane equivalent. Read in full and tail locally: herdr's own --lines N
# returns the last N *raw rows* including trailing blanks, then trims them, so a
# screen that isn't full comes back empty. Tailing here always behaves.
function hcap() {
  local target="$1" lines="${2:-50}"
  local id; id="$(_h_id "$target")" || return 1
  herdr pane read "$id" --source recent-unwrapped | tail -n "$lines"
}

# hwait build "Compiled successfully" [timeout_ms]
# Matches against output that already exists, so it is safe to call after the fact.
function hwait() {
  local target="$1" pattern="$2" timeout="${3:-120000}"
  [[ -n "$pattern" ]] || { print -u2 "usage: hwait <target> <pattern> [timeout_ms]"; return 1 }
  local id; id="$(_h_id "$target")" || return 1
  herdr pane wait-output "$id" --match "$pattern" --timeout "$timeout" >/dev/null
}

# Run a command in another pane and get its output and exit code back here.
#
# Screen-scraping a pane can't tell you when a command finished or whether it
# failed, so the command is wrapped to redirect into a temp file and append an
# exit-code sentinel. We poll that file rather than the terminal, so the result
# is exact and free of prompts and ANSI noise.
#
#   hx build "npm test"    -> prints output, returns the command's exit status
function hx() {
  local target="$1"; shift
  (( $# )) || { print -u2 "usage: hx <target> <command...>"; return 1 }
  local id; id="$(_h_id "$target")" || return 1

  # typing into an agent's TUI would submit a prompt, not run a command
  local agent
  agent="$(herdr pane list 2>/dev/null |
    jq -r --arg id "$id" '.result.panes[] | select(.pane_id == $id) | .agent // ""')"
  if [[ -n "$agent" ]]; then
    print -u2 "$id is running '$agent' — use hask to prompt it, or pick a shell pane"
    return 1
  fi

  local out; out="$(mktemp "${TMPDIR:-/tmp}/herdr-hx.XXXXXX")" || return 1
  herdr pane run "$id" "{ $* ; } >'$out' 2>&1; printf '__HERDR_RC:%s__\n' \$? >>'$out'" || {
    rm -f "$out"; return 1
  }

  local waited=0 timeout="${HERDR_HX_TIMEOUT:-60}"
  while ! grep -q '__HERDR_RC:' "$out" 2>/dev/null; do
    sleep 0.2
    (( waited += 1 ))
    if (( waited > timeout * 5 )); then
      print -u2 "hx: timed out after ${timeout}s waiting on $id (is it at a prompt?)"
      sed '/__HERDR_RC:/d' "$out" >&2
      rm -f "$out"
      return 124
    fi
  done

  local rc; rc="$(sed -n 's/.*__HERDR_RC:\([0-9]*\)__.*/\1/p' "$out")"
  sed '/__HERDR_RC:/d' "$out"
  rm -f "$out"
  return "${rc:-0}"
}

# Prompt an agent pane, wait for it to settle, then print what it said.
# Returns non-zero if it ends up blocked on an approval instead of answering.
function hask() {
  local target="$1"; shift
  (( $# )) || { print -u2 "usage: hask <agent> <prompt...>"; return 1 }
  local id; id="$(_h_id "$target")" || return 1

  herdr agent prompt "$id" "$*" --wait --timeout "${HERDR_ASK_TIMEOUT:-300000}" >/dev/null || {
    print -u2 "hask: prompt failed or timed out; check 'herdr agent get $id'"
    return 1
  }
  herdr agent read "$id" --source recent-unwrapped | tail -n "${HERDR_ASK_LINES:-80}"

  local status
  status="$(herdr agent get "$id" 2>/dev/null | jq -r '.result.agent.agent_status // ""')"
  [[ "$status" == blocked ]] && { print -u2 "(agent is blocked — it wants input)"; return 2 }
  return 0
}

# hspawn test "npm test -- --watch"
# Sibling pane in the current tab, labeled, focus left where it is. Splits a wide
# pane sideways and a tall one downward so repeated spawns stay usable.
function hspawn() {
  local name="$1"; shift
  [[ -n "$name" ]] || { print -u2 "usage: hspawn <name> [command...]"; return 1 }
  _h_guard || return 1

  local rect cols rows dir
  rect="$(herdr pane layout --pane "$HERDR_PANE_ID" 2>/dev/null |
    jq -r --arg id "$HERDR_PANE_ID" \
      '.result.layout.panes[] | select(.pane_id == $id) | "\(.rect.width) \(.rect.height)"')"
  cols="${rect%% *}"; rows="${rect##* }"
  if (( ${cols:-0} > ${rows:-0} * 2 )); then dir=right; else dir=down; fi

  local id
  id="$(herdr pane split --current --direction "$dir" --cwd "$PWD" --no-focus |
    jq -r '.result.pane.pane_id')" || return 1
  [[ -n "$id" && "$id" != null ]] || { print -u2 "hspawn: split failed"; return 1 }

  herdr pane rename "$id" "$name" >/dev/null
  (( $# )) && herdr pane run "$id" "$*"
  print -r -- "$id ($name)"
}

function hkill() {
  local id; id="$(_h_id "${1:-}")" || return 1
  if [[ "$id" == "$HERDR_PANE_ID" ]]; then
    print -u2 "refusing to close the calling pane; pass a target explicitly"
    return 1
  fi
  herdr pane close "$id" >/dev/null && print -r -- "closed $id"
}

# ── completion: pane labels, agent names, and raw pane IDs ──────────
function _h_complete_targets() {
  [[ "${HERDR_ENV:-}" == 1 ]] || return
  local out
  out="$(herdr pane list 2>/dev/null | jq -r '.result.panes[] | .label // .agent // .pane_id')"
  [[ -z "$out" ]] && return
  local -a targets=(${(f)out})
  compadd -a targets
}
if (( $+functions[compdef] )); then
  compdef _h_complete_targets hid hsend hkeys hrun hcap hwait hx hask hkill hname
fi
