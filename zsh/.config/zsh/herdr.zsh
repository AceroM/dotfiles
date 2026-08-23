# Herdr helpers — address panes by name, talk between them, scrape their output.
#
# Herdr's own CLI is complete but addresses panes by opaque IDs (w1:p5) and
# returns JSON. These wrappers add: name-based targeting, tmux-style
# capture/send verbs, and a real request/response call between panes (hx).
#
#   hd  <t>                resolve a target      hs    <t> <text>  type text / keys
#   j   <t> [n]            read output           hsend <t> <text>  type text, no Enter
#   hl                     spaces > tabs > panes hkeys <t> <key>   send key presses
#   hls                    list panes            hrun  <t> <cmd>   type cmd + Enter
#   hname [<t>] <name>     label a pane          hwait <t> <pat>   wait for output
#   hspawn <name> [cmd]    new labeled pane      hkill <t>         close a pane
#   hx   <t> <cmd>         run + capture stdout/stderr + exit code
#   hask <agent> <prompt>  prompt an agent, wait, print its reply
#   hc                     reload config.toml    eh                edit config.toml
#
# <target> is, in resolution order:
#
#   empty / "." / self       the calling pane
#   w1:p5                    a pane ID, used literally
#   w1:t3                    a tab ID -> that tab's focused pane
#   {space}:{tab}            a space and tab by name  -> the tab's focused pane
#   {space}:                 a space by name          -> its active tab
#   {name}                   a pane label or agent name, then a tab in the
#                            current space, then a space by name
#
# Names are matched in snake_case, so a space titled "Self Serve" and a tab
# titled "posthog events" are both addressed as self_serve:posthog_events, and
# a tab shown as "dev6 :3001" is servers:dev6_3001. An unambiguous prefix is
# enough: self:post resolves the same tab. Ambiguity is an error, never a coin
# flip, since the next command would mutate the wrong pane.
#
#   hl                                  the whole tree, with the IDs below
#   j  self_serve:posthog_events        read that tab's focused pane
#   j  -a self_serve:posthog_events     read its agent pane instead
#   hd self_serve:posthog_events        just print the pane ID
#   hs w10:p12 hello enter              type into a pane by ID and submit
#   hx servers:dev6_3001 "git status"   run a command over there
#
# Everything requires running inside Herdr (HERDR_ENV=1).

# stale aliases from older versions of this file shadow the functions below
unalias hd hl j hc hrc hs hls hid hname hsend hkeys hrun hcap hwait hx hask hspawn hkill 2>/dev/null

alias h="herdr"
alias eh="nvim ~/.config/herdr/config.toml"

# hc — push config.toml into the running server.
#
# The server parses config.toml once, at startup, and never looks at it again:
# a session that has been up for a week is still running whatever it read back
# then, so edits sit in the file changing nothing. Every edit ends here.
#
# hr was this command once; it attaches to the remote box now (see
# herdr-private.zsh), and hrc still works as a second name for this one.
# Diagnostics come back as plain strings next to a status of
# applied/partial/failed — a partial reload keeps the old value for whatever it
# rejected, so they get printed. The silent case is a config that looks live
# and isn't.
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

function _h_guard() {
  if [[ "${HERDR_ENV:-}" != 1 ]]; then
    print -u2 "not inside a Herdr pane (HERDR_ENV unset)"
    return 1
  fi
}

# ── name resolution ─────────────────────────────────────────────────
#
# Spaces and tabs carry display labels ("Self Serve", "dev6 :3001"); panes carry
# only IDs. Addressing goes through the labels, folded to snake_case on both
# sides so what I type matches what I read off the sidebar regardless of case,
# spaces, or punctuation.

# the same fold, in jq, for slugging whole listings in one process
typeset -g _H_SLUG_JQ='def slug: (. // "") | ascii_downcase | gsub("[^a-z0-9]+"; "_") | sub("^_"; "") | sub("_$"; "");'

function _h_slug() {
  local s="${(L)1}"
  s="${s//[^a-z0-9]/_}"
  while [[ "$s" == *__* ]]; do s="${s//__/_}"; done
  print -r -- "${${s#_}%_}"
}

# match a needle against "id<TAB>slug" rows on stdin: an exact slug wins,
# otherwise a unique prefix. Several matches is an error, not a coin flip.
function _h_match() {
  local needle="$1" kind="$2" rows hits
  rows="$(cat)"
  hits="$(print -r -- "$rows" | awk -F'\t' -v n="$needle" '$2 == n { print $1 }')"
  [[ -n "$hits" ]] ||
    hits="$(print -r -- "$rows" | awk -F'\t' -v n="$needle" 'index($2, n) == 1 { print $1 }')"

  local -a ids=(${(f)hits})
  case ${#ids} in
    0) print -u2 "no $kind named '$needle'"; return 1 ;;
    1) print -r -- "$ids[1]" ;;
    *) print -u2 "'$needle' matches several ${kind}s: $ids"; return 1 ;;
  esac
}

function _h_workspace_id() {
  local needle; needle="$(_h_slug "$1")"
  [[ -n "$needle" ]] || { print -u2 "empty space name"; return 1 }
  herdr workspace list 2>/dev/null |
    jq -r "$_H_SLUG_JQ"'.result.workspaces[] | [.workspace_id, (.label|slug)] | @tsv' |
    _h_match "$needle" space
}

function _h_tab_id() {
  local ws="$1" needle; needle="$(_h_slug "$2")"
  [[ -n "$needle" ]] || { print -u2 "empty tab name"; return 1 }
  herdr tab list --workspace "$ws" 2>/dev/null |
    jq -r "$_H_SLUG_JQ"'.result.tabs[] | [.tab_id, (.label|slug)] | @tsv' |
    _h_match "$needle" tab
}

function _h_active_tab() {
  herdr workspace get "$1" 2>/dev/null | jq -r '.result.workspace.active_tab_id // empty'
}

# every pane in a tab, in layout order (left to right, top to bottom)
function _h_tab_panes() {
  local tab="$1" seed
  seed="$(herdr pane list 2>/dev/null |
    jq -r --arg t "$tab" '[.result.panes[] | select(.tab_id == $t) | .pane_id][0] // empty')"
  [[ -n "$seed" ]] || { print -u2 "no panes in tab '$tab'"; return 1 }
  herdr pane layout --pane "$seed" 2>/dev/null | jq -r '.result.layout.panes[].pane_id'
}

# a tab's own focused pane — the one I was last looking at in there, which is
# the pane a bare {space}:{tab} means. Only one pane app-wide reports
# focused=true, so this comes from the tab's layout, not from pane list.
function _h_tab_pane() {
  local tab="$1" seed id
  seed="$(herdr pane list 2>/dev/null |
    jq -r --arg t "$tab" '[.result.panes[] | select(.tab_id == $t) | .pane_id][0] // empty')"
  [[ -n "$seed" ]] || { print -u2 "no panes in tab '$tab'"; return 1 }
  id="$(herdr pane layout --pane "$seed" 2>/dev/null |
    jq -r '.result.layout.focused_pane_id // empty')"
  print -r -- "${id:-$seed}"
}

function _h_tab_agent_pane() {
  local tab="$1" hits
  hits="$(herdr agent list 2>/dev/null |
    jq -r --arg t "$tab" '.result.agents[] | select(.tab_id == $t) | .pane_id')"
  local -a ids=(${(f)hits})
  case ${#ids} in
    0) print -u2 "no agent in tab '$tab'"; return 1 ;;
    1) print -r -- "$ids[1]" ;;
    *) print -u2 "tab '$tab' hosts several agents: $ids"; return 1 ;;
  esac
}

# "{space}:{tab}", "{space}:", or a bare "{tab}"/"{space}" -> a tab ID
function _h_addr() {
  local target="$1" ws tab ws_id
  if [[ "$target" == *:* ]]; then
    ws="${target%%:*}"; tab="${target#*:}"
    ws_id="$(_h_workspace_id "$ws")" || return 1
    [[ -n "$(_h_slug "$tab")" ]] || { _h_active_tab "$ws_id"; return }
    _h_tab_id "$ws_id" "$tab"
    return
  fi
  # a bare name: a tab in the space I'm sitting in wins over a space elsewhere
  _h_tab_id "$HERDR_WORKSPACE_ID" "$target" 2>/dev/null && return 0
  ws_id="$(_h_workspace_id "$target" 2>/dev/null)" || return 1
  _h_active_tab "$ws_id"
}

# resolve any <target> to a pane ID. See the table at the top of this file.
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
  if [[ "$target" =~ '^w[0-9A-Za-z]+:t[0-9A-Za-z]+$' ]]; then
    _h_tab_pane "$target"
    return
  fi
  # a colon means the caller wrote an address, so surface the address errors
  # ("no space named x") rather than a misleading "no pane named x:y"
  if [[ "$target" == *:* ]]; then
    local tab; tab="$(_h_addr "$target")" || return 1
    [[ -n "$tab" ]] || { print -u2 "'$target' resolves to no tab"; return 1 }
    _h_tab_pane "$tab"
    return
  fi

  local json matches
  json="$(herdr pane list 2>/dev/null)" || { print -u2 "herdr pane list failed"; return 1 }
  matches="$(print -r -- "$json" |
    jq -r --arg t "$target" '.result.panes[] | select(.label == $t or .agent == $t) | .pane_id')"
  local -a ids=(${(f)matches})
  (( ${#ids} == 1 )) && { print -r -- "$ids[1]"; return 0 }

  # no pane label matched, or several did — an exact tab/space name beats both
  local tab; tab="$(_h_addr "$target" 2>/dev/null)"
  [[ -n "$tab" ]] && { _h_tab_pane "$tab"; return }

  if (( ${#ids} > 1 )); then
    print -u2 "'$target' matches several panes: $ids"
  else
    print -u2 "no pane, tab, or space named '$target'"
  fi
  return 1
}

# hd self_serve:posthog_events      -> the tab's focused pane
# hd -a self_serve:posthog_events   -> the agent pane in that tab
# hd -l self_serve:posthog_events   -> every pane in that tab
function hd() {
  local mode=pane
  while [[ "${1:-}" == -?* ]]; do
    case "$1" in
      -a|--agent) mode=agent ;;
      -l|--list)  mode=list ;;
      -h|--help)  print -r -- "usage: hd [-a|-l] <space>:<tab>|<name>|<pane_id>"; return 0 ;;
      *) print -u2 "hd: unknown flag '$1'"; return 1 ;;
    esac
    shift
  done

  local id; id="$(_h_id "${1:-}")" || return 1
  [[ "$mode" == pane ]] && { print -r -- "$id"; return 0 }

  local tab
  tab="$(herdr pane get "$id" 2>/dev/null | jq -r '.result.pane.tab_id // empty')"
  [[ -n "$tab" ]] || { print -u2 "hd: no tab for pane $id"; return 1 }
  case "$mode" in
    agent) _h_tab_agent_pane "$tab" ;;
    list)  _h_tab_panes "$tab" ;;
  esac
}

function hid() { hd "$@" }

# The whole tree: every space, its tabs, and their panes, each with its ID —
# the IDs every other function here takes as a <target>.
#
# Three list calls stitched in one jq pass, because each level's JSON carries
# only its parent's ID, never its children. Columns are padded in jq rather
# than piped through column(1), which strips the leading indentation that makes
# this readable as a tree.
#
# * marks what Herdr has focused at each level, > the calling pane.
function hl() {
  _h_guard || return 1
  local ws tabs panes
  ws="$(herdr workspace list 2>/dev/null)" || { print -u2 "hl: workspace list failed"; return 1 }
  tabs="$(herdr tab list 2>/dev/null)"     || { print -u2 "hl: tab list failed"; return 1 }
  panes="$(herdr pane list 2>/dev/null)"   || { print -u2 "hl: pane list failed"; return 1 }

  jq -rn --argjson w "$ws" --argjson t "$tabs" --argjson p "$panes" \
         --arg self "$HERDR_PANE_ID" --arg home "$HOME" '
    def pad($n): . + ((" " * ($n - length)) // "");
    def tilde:  if startswith($home) then "~" + .[($home | length):] else . end;
    def n($word): "\(.) \($word)" + (if . == 1 then "" else "s" end);

    [ $w.result.workspaces | sort_by(.number)[] as $ws
      | [ (if $ws.focused then "*" else " " end),
          $ws.workspace_id,
          ($ws.label // "-"),
          ($ws.tab_count | n("tab")) + ", " + ($ws.pane_count | n("pane")) ],
        ( $t.result.tabs | map(select(.workspace_id == $ws.workspace_id)) | sort_by(.number)[] as $tab
          | [ (if $tab.focused then "*" else " " end),
              "  " + $tab.tab_id,
              ($tab.label // "-"),
              ($tab.pane_count | n("pane")) ],
            ( $p.result.panes | map(select(.tab_id == $tab.tab_id))[] as $pane
              | [ (if $pane.pane_id == $self then ">" elif $pane.focused then "*" else " " end),
                  "    " + $pane.pane_id,
                  ($pane.label // $pane.agent // "-"),
                  ((if $pane.agent then "\($pane.agent_status)  " else "" end)
                   + (($pane.cwd // "-") | tilde)) ] ) ) ]
    | (map(.[1] | length) | max) as $w1
    | (map(.[2] | length) | max) as $w2
    | .[] | "\(.[0]) \(.[1] | pad($w1))  \(.[2] | pad($w2))  \(.[3])" | sub(" +$"; "")
  '
}

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

# Key names herdr accepts that are whole words. Single characters are keys to
# herdr too, but treating a bare one as a key here would swallow the "5" in
# `hs build git log -n 5`, so a lone character only counts as a key once it
# carries a modifier (ctrl+c, cmd+k).
typeset -ga _H_KEYS=(enter return esc escape tab space backspace bs up down left right)
typeset -ga _H_MODS=(ctrl alt option meta cmd super shift)

function _h_is_key() {
  local k="${(L)1}"
  [[ -n "$k" && "$k" != *[[:space:]]* ]] || return 1
  local -a parts=(${(s:+:)k})
  local base="${parts[-1]}" i
  if (( ${#parts} > 1 )); then
    for (( i = 1; i < ${#parts}; i++ )); do
      (( ${_H_MODS[(Ie)${parts[i]}]} )) || return 1
    done
    (( ${#base} == 1 )) && return 0
  fi
  [[ "$base" == f<1-20> ]] && return 0
  (( ${_H_KEYS[(Ie)$base]} ))
}

# hs <target> <text-or-keys...> — the one sender, addressed by ID or name.
#
#   hs w10:p12 hello          type "hello", leave it uncommitted
#   hs w10:p12 hello enter    type it, then submit
#   hs w10:p12 ctrl+c         just the key
#   hs -l w10:p12 press esc   literal text, no key sniffing
#   hs -k w10:p12 up up enter keys only
#
# Arguments are joined with spaces and sent as text, except for a *trailing*
# run of key names (enter, esc, ctrl+c, f5, ...), which is sent as key presses
# afterwards. Only the trailing run is sniffed, so a word like "space" or "up"
# in the middle of a sentence stays text.
#
# Raw pane input: for an agent, hask goes through the agent surface, which gets
# bracketed paste and submission right.
function hs() {
  local literal=0 keysonly=0
  while [[ "${1:-}" == -?* ]]; do
    case "$1" in
      -l|--literal) literal=1 ;;
      -k|--keys)    keysonly=1 ;;
      -h|--help)    print -r -- "usage: hs [-l|-k] <target> <text-or-keys...>"; return 0 ;;
      --) shift; break ;;
      *) print -u2 "hs: unknown flag '$1'"; return 1 ;;
    esac
    shift
  done

  local target="${1:-}"; shift 2>/dev/null
  (( $# )) || { print -u2 "usage: hs [-l|-k] <target> <text-or-keys...>"; return 1 }
  local id out; id="$(_h_id "$target")" || return 1

  if (( keysonly )); then
    out="$(herdr pane send-keys "$id" "$@" 2>&1)" || { print -u2 -- "$out"; return 1 }
    return 0
  fi

  local -a words=("$@") keys=()
  if (( ! literal )); then
    while (( ${#words} )) && _h_is_key "${words[-1]}"; do
      keys=("${words[-1]}" $keys)
      words=("${(@)words[1,-2]}")
    done
  fi

  if (( ${#words} )); then
    out="$(herdr pane send-text "$id" "${(j: :)words}" 2>&1)" || { print -u2 -- "$out"; return 1 }
  fi
  if (( ${#keys} )); then
    out="$(herdr pane send-keys "$id" "${keys[@]}" 2>&1)" || { print -u2 -- "$out"; return 1 }
  fi
  return 0
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

# j self_serve:posthog_events [lines]   — capture-pane equivalent.
#
# Read in full and tail locally: herdr's own --lines N returns the last N *raw
# rows* including trailing blanks, then trims them, so a screen that isn't full
# comes back empty. Tailing here always behaves.
#
# -a reads the tab's agent pane instead of whichever pane it has focused, which
# is what I want whenever I left the shell half of a split selected.
function j() {
  local -a hdflags=()
  while [[ "${1:-}" == -?* ]]; do hdflags+=("$1"); shift; done
  local target="${1:-}" lines="${2:-50}"
  local id; id="$(hd $hdflags "$target")" || return 1
  herdr pane read "$id" --source recent-unwrapped | tail -n "$lines"
}

function hcap() { j "$@" }

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

# ── completion: {space}:{tab} addresses, then space names ───────────
function _h_complete_targets() {
  [[ "${HERDR_ENV:-}" == 1 ]] || return
  local spaces tabs out
  spaces="$(herdr workspace list 2>/dev/null)" || return
  tabs="$(herdr tab list 2>/dev/null)" || return
  out="$(jq -rn --argjson s "$spaces" --argjson t "$tabs" "$_H_SLUG_JQ"'
    ($s.result.workspaces | map({key: .workspace_id, value: (.label|slug)}) | from_entries) as $m
    | ($t.result.tabs[] | "\($m[.workspace_id] // .workspace_id):\(.label|slug)"),
      ($s.result.workspaces[] | (.label|slug) + ":")' 2>/dev/null)"
  [[ -z "$out" ]] && return
  local -a targets=(${(f)out})
  compadd -a targets
}
if (( $+functions[compdef] )); then
  compdef _h_complete_targets hd hid j hcap hs hsend hkeys hrun hwait hx hask hkill hname
fi
