# Rex helpers — address panes by name, talk between them, scrape their output.
#
# The Herdr verbs (herdr.zsh) on Rex, so muscle memory carries over. Rex calls
# a space a session, a tab a window, and a pane a block; its CLI wants full
# opaque IDs and a session for every block (`-s S -b B`). These wrappers add
# name-based targeting, tmux-style capture/send verbs, and a real
# request/response call between panes (hx). Agent lookups go through
# rex-agents (cli/.local/bin), which knows which panes run Claude or Codex.
#
#   hd  <t>                resolve a target      hs    <t> <text>  type text / keys
#   hi                     current pane ID       hsend <t> <text>  type text, no Enter
#   j   <t> [n]            read output (= hr)    hkeys <t> <key>   send key presses
#   hl                     sessions>tabs>panes   hrun  <t> <cmd>   type cmd + Enter
#   hls                    every pane, flat      hwait <t> <pat>   wait for output
#   hp   [<t>]             panes in one tab      hkill <t>         close a pane
#   hspawn <name> [cmd]    new sibling pane      ce                close other tabs
#   hx   <t> <cmd>         run + capture stdout/stderr + exit code
#   hask <agent> <prompt>  prompt an agent, wait, print its reply
#
# <target> is, in resolution order:
#
#   empty / "." / self       the calling pane
#   block:…  window:…        a full ID (a window -> its focused pane,
#   session:…                a session -> its active tab's focused pane)
#   {session}:{tab}          a session and tab by name -> the tab's focused pane
#   {session}:               a session by name         -> its active tab
#   {name}                   a tab in the current session, then a session by
#                            name, then the end of any ID (6+ characters, the
#                            short IDs hl prints)
#
# Names are matched in snake_case, so the session labelled "prod-1234" is
# prod_1234: and a tab labelled "dev6 :3001" in servers is servers:dev6_3001.
# An unambiguous prefix is enough. Ambiguity is an error, never a coin flip, since the next
# command would mutate the wrong pane. Pane labels are not names here:
# ~/.config/rex/pane-labels.lua rewrites every one to "<dir>  <title>".
#
#   hl                                  the whole tree, with short IDs
#   j  agents:auth_tests                read that tab's focused pane
#   j  -a agents:auth_tests             read its agent pane instead
#   hd agents:auth_tests                just print the pane ID
#   hs 9f3c2a hello enter               type into a pane by short ID and submit
#   hx servers:dev6_3001 "git status"   run a command over there
#
# Everything requires running inside Rex (REX_SESSION and REX_BLOCK set). No
# verb types into the calling pane.

# stale aliases would shadow the functions below
unalias hd hi hl j hr hs hls hp hid hsend hkeys hrun hcap hwait hx hask hspawn hkill ce 2>/dev/null
zmodload zsh/datetime  # EPOCHREALTIME, for hwait and hask deadlines

function _r_guard() {
  if [[ -z "${REX_SESSION:-}" || -z "${REX_BLOCK:-}" ]]; then
    print -u2 "not inside a Rex pane (REX_SESSION/REX_BLOCK unset)"
    return 1
  fi
}

function hi() {
  _r_guard || return 1
  print -r -- "$REX_BLOCK"
}

# ── name resolution ─────────────────────────────────────────────────
#
# Sessions and tabs carry labels ("agents", "dev6_3001"); panes carry only IDs
# worth addressing. Labels are folded to snake_case on both sides, so what I
# type matches what I read off the sidebar regardless of case or punctuation.

# the same fold, in jq, for slugging whole listings in one process; `order`
# walks a layer's layout tree into reading order (left to right, top to bottom)
typeset -g _R_SLUG_JQ='def slug: (. // "") | ascii_downcase | gsub("[^a-z0-9]+"; "_") | sub("^_"; "") | sub("_$"; "");'
typeset -g _R_ORDER_JQ='def order: if .block_id then .block_id elif .split then (.split.before | order), (.split.after | order) else empty end;
def panes: ([.layers[]? | .layout | order]) as $laid | $laid + ([.layers[]?.blocks[]?.block_id] - $laid);'

function _r_slug() {
  local s="${(L)1}"
  s="${s//[^a-z0-9]/_}"
  while [[ "$s" == *__* ]]; do s="${s//__/_}"; done
  print -r -- "${${s#_}%_}"
}

# Every session's `session inspect`, as one JSON array: windows, their layouts
# and blocks, and each session's active window. Rex has no all-sessions view.
function _r_tree() {
  local ids s
  ids="$(rex ls --json 2>/dev/null | jq -r '.sessions[]?.session_id')"
  [[ -n "$ids" ]] || { print -u2 "rex ls failed or found no sessions"; return 1 }
  for s in ${(f)ids}; do rex session inspect "$s" --json 2>/dev/null; done | jq -cs '.'
}

# match a needle against "id<TAB>slug" rows on stdin: an exact slug wins,
# otherwise a unique prefix. Several matches is an error, not a coin flip.
function _r_match() {
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

function _r_session_id() {
  local tree="$1" needle; needle="$(_r_slug "$2")"
  [[ -n "$needle" ]] || { print -u2 "empty session name"; return 1 }
  print -r -- "$tree" | jq -r "$_R_SLUG_JQ"'.[] | [.session_id, (.label|slug)] | @tsv' |
    _r_match "$needle" session
}

function _r_window_id() {
  local tree="$1" sid="$2" needle; needle="$(_r_slug "$3")"
  [[ -n "$needle" ]] || { print -u2 "empty tab name"; return 1 }
  print -r -- "$tree" |
    jq -r --arg s "$sid" "$_R_SLUG_JQ"'.[] | select(.session_id == $s) | .windows[]? | [.window_id, (.label|slug)] | @tsv' |
    _r_match "$needle" tab
}

# a tab's own focused pane — the one I was last looking at in there, which is
# the pane a bare {session}:{tab} means. Empty window = the session's active tab.
function _r_window_pane() {
  local tree="$1" sid="$2" wid="${3:-}" out
  out="$(print -r -- "$tree" | jq -r --arg s "$sid" --arg w "$wid" "$_R_ORDER_JQ"'
    .[] | select(.session_id == $s) | (if $w == "" then .active_window_id else $w end) as $w
    | .windows[]? | select(.window_id == $w)
    | "\($s)\t\(.focused_block_id // ([panes[]][0]) // "")"')"
  [[ -n "$out" && "$out" != *$'\t' ]] || { print -u2 "no panes in tab '${wid:-active tab of $sid}'"; return 1 }
  print -r -- "$out"
}

# resolve any <target> to "<session ID><TAB><block ID>". See the table at the
# top of this file.
function _r_id() {
  local target="${1:-}"
  _r_guard || return 1

  if [[ -z "$target" || "$target" == "." || "$target" == self ]]; then
    print -r -- "$REX_SESSION"$'\t'"$REX_BLOCK"
    return 0
  fi

  local tree hits; tree="$(_r_tree)" || return 1

  # full IDs, used literally — only which session they live in is looked up
  case "$target" in
    block:*|window:*|session:*)
      hits="$(print -r -- "$tree" | jq -r --arg id "$target" "$_R_ORDER_JQ"'
        .[] | .session_id as $s | . as $ses
        | if $id == $s then $ses.active_window_id as $a | $ses.windows[]? | select(.window_id == $a)
          else .windows[]? | select(.window_id == $id or any(.layers[]?.blocks[]?; .block_id == $id)) end
        | "\($s)\t\(if ($id | startswith("block:")) then $id else (.focused_block_id // ([panes[]][0])) end)"')"
      [[ -n "$hits" ]] || { print -u2 "no pane, tab, or session '$target'"; return 1 }
      print -r -- "${hits%%$'\n'*}"
      return 0
      ;;
  esac

  local sid wid
  if [[ "$target" == *:* ]]; then
    # a colon means the caller wrote an address, so surface the address errors
    sid="$(_r_session_id "$tree" "${target%%:*}")" || return 1
    if [[ -n "$(_r_slug "${target#*:}")" ]]; then
      wid="$(_r_window_id "$tree" "$sid" "${target#*:}")" || return 1
    fi
    _r_window_pane "$tree" "$sid" "$wid"
    return
  fi

  # a bare name: a tab in the session I'm sitting in wins over a session elsewhere
  if wid="$(_r_window_id "$tree" "$REX_SESSION" "$target" 2>/dev/null)"; then
    _r_window_pane "$tree" "$REX_SESSION" "$wid"
    return
  fi
  if sid="$(_r_session_id "$tree" "$target" 2>/dev/null)"; then
    _r_window_pane "$tree" "$sid"
    return
  fi

  # the end of an ID, as hl/hls/hp print them
  if (( ${#target} >= 6 )) && [[ "$target" != *[^0-9a-f-]* ]]; then
    hits="$(print -r -- "$tree" | jq -r --arg p "$target" "$_R_ORDER_JQ"'
      .[] | .session_id as $s | . as $ses
      | ( .windows[]? | . as $w
          | (.layers[]?.blocks[]? | select(.block_id | endswith($p)) | "\($s)\t\(.block_id)"),
            (select(.window_id | endswith($p)) | "\($s)\t\($w.focused_block_id // ([panes[]][0]))") ),
        ( select($s | endswith($p)) | $ses.active_window_id as $a
          | $ses.windows[]? | select(.window_id == $a) | "\($s)\t\(.focused_block_id // ([panes[]][0]))" )')"
    local -a rows=(${(f)hits})
    case ${#rows} in
      1) print -r -- "$rows[1]"; return 0 ;;
      0) ;;
      *) print -u2 "'$target' matches several IDs"; return 1 ;;
    esac
  fi

  print -u2 "no tab, session, or ID named '$target'"
  return 1
}

# _r_at [-a] <target> sets $rs and $rb (session and block) in the caller, which
# declares them local first. -a swaps a non-agent pane for the agent pane in
# its tab — what I want whenever I left the shell half of a split selected.
function _r_at() {
  local agent=0
  [[ "${1:-}" == -a ]] && { agent=1; shift }
  local sb; sb="$(_r_id "${1:-}")" || return 1
  rs="${sb%%$'\t'*}"; rb="${sb#*$'\t'}"
  (( agent )) || return 0

  local agents wid hits
  agents="$(rex-agents --json 2>/dev/null)" || agents='[]'
  print -r -- "$agents" | jq -e --arg b "$rb" 'any(.[]; .block_id == $b)' >/dev/null && return 0
  wid="$(rex block inspect -s "$rs" "$rb" --json 2>/dev/null | jq -r '.block.window_id // empty')"
  [[ -n "$wid" ]] || { print -u2 "no tab for pane $rb"; return 1 }
  hits="$(print -r -- "$agents" | jq -r --arg w "$wid" '.[] | select(.window_id == $w) | .block_id')"
  local -a ids=(${(f)hits})
  case ${#ids} in
    0) print -u2 "no agent in the tab of $rb"; return 1 ;;
    1) rb="$ids[1]" ;;
    *) print -u2 "that tab hosts several agents: $ids"; return 1 ;;
  esac
}

# the coding agent (claude/codex) a pane runs, if any. rex-agents knows: an
# agent running a tool has bash in the foreground, and only its reported
# status still says claude.
function _r_agent_kind() {
  rex-agents --all --json 2>/dev/null | jq -r --arg b "$1" 'first(.[] | select(.block_id == $b) | .agent) // ""'
}

# the state an agent last reported (OSC 7501), the way rex-agents reads it:
# idle | working | done | blocked | error, else unknown. Two calls rather than
# a whole rex-agents pass, since hask polls it.
function _r_agent_state() {
  local proc st
  proc="$(rex block call -s "$1" -b "$2" process 2>/dev/null)"
  st="$(rex block call -s "$1" -b "$2" program_status 2>/dev/null)"
  [[ -n "$proc" ]] || proc='{}'
  [[ -n "$st" ]] || st='{}'
  jq -rn --argjson p "$proc" --argjson st "$st" '
    ($p.foreground.pid // null) as $fg
    | [$st.records[]? | select((.owner.pid // null) as $o | $o == null or $o == $fg)] as $r
    | ((first($r[] | select(.id == null)) // $r[0] // {}) | .state) // "unknown"'
}

function _r_not_self() {
  [[ "$1" != "$REX_BLOCK" ]] && return 0
  print -u2 "refusing to type into the calling pane; pass a target explicitly"
  return 1
}

# hd agents:auth_tests      -> the tab's focused pane
# hd -a agents:auth_tests   -> the agent pane in that tab
# hd -l agents:auth_tests   -> every pane in that tab, in layout order
function hd() {
  local mode=pane
  while [[ "${1:-}" == -?* ]]; do
    case "$1" in
      -a|--agent) mode=agent ;;
      -l|--list)  mode=list ;;
      -h|--help)  print -r -- "usage: hd [-a|-l] <session>:<tab>|<name>|<id>"; return 0 ;;
      *) print -u2 "hd: unknown flag '$1'"; return 1 ;;
    esac
    shift
  done

  local rs rb
  case "$mode" in
    pane)  _r_at "${1:-}" || return 1; print -r -- "$rb" ;;
    agent) _r_at -a "${1:-}" || return 1; print -r -- "$rb" ;;
    list)
      _r_at "${1:-}" || return 1
      local wid; wid="$(rex block inspect -s "$rs" "$rb" --json 2>/dev/null | jq -r '.block.window_id // empty')"
      rex session inspect "$rs" --json 2>/dev/null |
        jq -r --arg w "$wid" "$_R_ORDER_JQ"'.windows[] | select(.window_id == $w) | panes[]'
      ;;
  esac
}

function hid() { hd "$@" }

# The whole tree: every session, its tabs, and their panes, each with the short
# ID (the end of the full one) that every function here takes as a <target>.
#
# Structure comes from `session inspect`, one per session; what each pane runs
# (agent and state, or the program) from one `rex-agents --all` pass. Columns
# are padded in jq rather than column(1), which strips the leading indentation
# that makes this readable as a tree.
#
# * marks each session's active tab and each tab's focused pane, > the calling pane.
function hl() {
  _r_guard || return 1
  local tree agents
  tree="$(_r_tree)" || return 1
  agents="$(rex-agents --all --json 2>/dev/null)" || agents='[]'

  jq -rn --argjson t "$tree" --argjson a "${agents:-[]}" --arg self "$REX_BLOCK" "$_R_ORDER_JQ"'
    def pad($n): . + ((" " * ($n - length)) // "");
    def n($word): "\(.) \($word)" + (if . == 1 then "" else "s" end);
    def short: .[-6:];
    ($a | map({key: .block_id, value: .}) | from_entries) as $by
    | [ $t[] as $s
        | [ " ", ($s.session_id | short), ($s.label // "-"),
            ($s.windows | length | n("tab")) + ", " + ([$s.windows[]?.layers[]?.blocks[]?] | length | n("pane")) ],
          ( $s.windows[]? as $w | [$w | panes[]] as $ids
            | [ (if $w.window_id == $s.active_window_id then "*" else " " end),
                "  " + ($w.window_id | short), ($w.label // "-"), ($ids | length | n("pane")) ],
              ( $ids[] as $id | ($by[$id] // {}) as $p
                | [ (if $id == $self then ">" elif $id == $w.focused_block_id then "*" else " " end),
                    "    " + ($id | short),
                    (if ($p.agent // "") != "" then "\($p.agent) \($p.state)" else ($p.program // "-") end),
                    (first($w.layers[]?.blocks[]? | select(.block_id == $id) | .label) // "-") ] ) ) ]
    | (map(.[1] | length) | max) as $w1
    | (map(.[2] | length) | max) as $w2
    | .[] | "\(.[0]) \(.[1] | pad($w1))  \(.[2] | pad($w2))  \(.[3])" | sub(" +$"; "")
  '
}

# panes as a table: id, session/tab, agent+state or program, cwd. * marks the
# calling pane. rex-agents --all, reshaped.
function hls() {
  _r_guard || return 1
  rex-agents --all --json | jq -r --arg self "$REX_BLOCK" --arg home "$HOME" '
    def tilde: if startswith($home) then "~" + .[($home | length):] else . end;
    .[]
    | [ (if .block_id == $self then "*" else " " end),
        (.block_id | .[-6:]),
        "\(.session // "-")/\(.tab // "-")",
        (if (.agent // "") != "" then "\(.agent) \(.state)" else (.program // "-") end),
        ((.cwd // "") | if . == "" then "-" else tilde end) ]
    | @tsv' | column -t -s $'\t'
}

# hp — just the panes sharing one tab, in layout order, with their IDs. Bare
# `hp` is the tab I'm sitting in; a <target> is the tab holding that pane
# ({session}:{tab}, a tab name, or any ID). hls is every pane in Rex, which is
# the wrong question when I only want my neighbours.
#
# > marks the calling pane, * the pane this tab has focused.
function hp() {
  _r_guard || return 1
  local rs rb wid agents
  _r_at "${1:-}" || return 1
  wid="$(rex block inspect -s "$rs" "$rb" --json 2>/dev/null | jq -r '.block.window_id // empty')"
  [[ -n "$wid" ]] || { print -u2 "hp: no tab for pane $rb"; return 1 }
  agents="$(rex-agents --all --json 2>/dev/null)" || agents='[]'

  rex session inspect "$rs" --json 2>/dev/null |
    jq -r --arg w "$wid" --argjson a "${agents:-[]}" --arg self "$REX_BLOCK" "$_R_ORDER_JQ"'
      ($a | map({key: .block_id, value: .}) | from_entries) as $by
      | .windows[] | select(.window_id == $w) | . as $win
      | panes[] as $id | ($by[$id] // {}) as $p
      | [ (if $id == $self then ">" elif $id == $win.focused_block_id then "*" else " " end),
          ($id | .[-6:]),
          (if ($p.agent // "") != "" then $p.agent else ($p.program // "-") end),
          (if ($p.agent // "") != "" then $p.state else "-" end),
          (first($win.layers[]?.blocks[]? | select(.block_id == $id) | .label) // "-") ]
      | @tsv' | column -t -s $'\t'
}

# Key names Rex's send-key accepts that are whole words, plus Herdr's return and
# bs. Single characters are keys too, but treating a bare one as a key here
# would swallow the "5" in `hs build git log -n 5`, so a lone character only
# counts as a key once it carries a modifier (ctrl+c, cmd+k).
typeset -ga _R_KEYS=(enter return esc escape tab space backspace bs up down left right
  home end pageup pagedown delete insert)
typeset -ga _R_MODS=(ctrl alt option meta cmd super shift)

function _r_is_key() {
  local k="${(L)1}"
  [[ -n "$k" && "$k" != *[[:space:]]* ]] || return 1
  local -a parts=(${(s:+:)k})
  local base="${parts[-1]}" i
  if (( ${#parts} > 1 )); then
    for (( i = 1; i < ${#parts}; i++ )); do
      (( ${_R_MODS[(Ie)${parts[i]}]} )) || return 1
    done
    (( ${#base} == 1 )) && return 0
  fi
  [[ "$base" == f<1-20> ]] && return 0
  (( ${_R_KEYS[(Ie)$base]} ))
}

# Herdr's spellings that Rex doesn't know
function _r_keys() {
  local k
  for k in "$@"; do
    case "${(L)k}" in
      return) print -r -- enter ;;
      bs)     print -r -- backspace ;;
      *)      print -r -- "$k" ;;
    esac
  done
}

# hs <target> <text-or-keys...> — the one sender, addressed by ID or name.
#
#   hs 9f3c2a hello          type "hello", leave it uncommitted
#   hs 9f3c2a hello enter    type it, then submit
#   hs 9f3c2a ctrl+c         just the key
#   hs -l 9f3c2a press esc   literal text, no key sniffing
#   hs -k 9f3c2a up up enter keys only
#
# Arguments are joined with spaces and sent as text, except for a *trailing*
# run of key names (enter, esc, ctrl+c, f5, ...), which is sent as key presses
# afterwards. Only the trailing run is sniffed, so a word like "space" or "up"
# in the middle of a sentence stays text.
#
# Raw pane input: for an agent, hask goes through rex-agents, which gets
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
  local rs rb; _r_at "$target" || return 1
  _r_not_self "$rb" || return 1

  if (( keysonly )); then
    rex send-key -s "$rs" -b "$rb" ${(f)"$(_r_keys "$@")"}
    return
  fi

  local -a words=("$@") keys=()
  if (( ! literal )); then
    while (( ${#words} )) && _r_is_key "${words[-1]}"; do
      keys=("${words[-1]}" $keys)
      words=("${(@)words[1,-2]}")
    done
  fi

  if (( ${#words} )); then
    rex send -s "$rs" -b "$rb" "${(j: :)words}" || return 1
  fi
  if (( ${#keys} )); then
    rex send-key -s "$rs" -b "$rb" ${(f)"$(_r_keys "${keys[@]}")"} || return 1
  fi
  return 0
}

function hsend() {
  local target="$1"; shift
  local rs rb; _r_at "$target" || return 1
  _r_not_self "$rb" || return 1
  rex send -s "$rs" -b "$rb" "$*"
}

function hkeys() {
  local target="$1"; shift
  (( $# )) || { print -u2 "usage: hkeys <target> <key...>"; return 1 }
  local rs rb; _r_at "$target" || return 1
  _r_not_self "$rb" || return 1
  rex send-key -s "$rs" -b "$rb" ${(f)"$(_r_keys "$@")"}
}

function hrun() {
  local target="$1"; shift
  (( $# )) || { print -u2 "usage: hrun <target> <command...>"; return 1 }
  local rs rb; _r_at "$target" || return 1
  _r_not_self "$rb" || return 1
  rex send -s "$rs" -b "$rb" "$*" && rex send-key -s "$rs" -b "$rb" enter
}

# j agents:auth_tests [lines]   — capture-pane equivalent: screen + scrollback,
# soft wraps joined, trailing blanks dropped, last <lines> kept (default 50).
#
# -a reads the tab's agent pane instead of whichever pane it has focused.
#
# ~/.zsh_private defines its own j (the worktree picker) and is sourced after
# this file, so there j is that one. hr and hcap call _r_read, not j, so they
# read panes either way.
function _r_read() {
  local -a flags=()
  while [[ "${1:-}" == -?* ]]; do
    case "$1" in
      -a|--agent) flags=(-a) ;;
      *) print -u2 "unknown flag '$1'"; return 1 ;;
    esac
    shift
  done
  local target="${1:-}" lines="${2:-50}"
  local rs rb; _r_at $flags "$target" || return 1
  rex capture -s "$rs" -b "$rb" --trim --unwrap | tail -n "$lines"
}

function j()    { _r_read "$@" }
function hcap() { _r_read "$@" }
function hr()   { _r_read "$@" }

# hwait build "Compiled successfully" [timeout_ms]
# Matches (grep -E) against output that already exists, so it is safe to call
# after the fact. Rex has no wait-for-output, so this polls the capture.
function hwait() {
  local target="$1" pattern="$2" timeout="${3:-120000}"
  [[ -n "$pattern" ]] || { print -u2 "usage: hwait <target> <pattern> [timeout_ms]"; return 1 }
  local rs rb; _r_at "$target" || return 1
  local deadline=$(( EPOCHREALTIME + timeout / 1000.0 ))
  until rex capture -s "$rs" -b "$rb" --trim --unwrap 2>/dev/null | grep -qE -- "$pattern"; do
    if (( EPOCHREALTIME > deadline )); then
      print -u2 "hwait: no '$pattern' in $rb after ${timeout}ms"
      return 124
    fi
    sleep 0.3
  done
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
  local rs rb; _r_at "$target" || return 1
  _r_not_self "$rb" || return 1

  # typing into an agent's TUI would submit a prompt, not run a command
  local agent; agent="$(_r_agent_kind "$rb")"
  if [[ -n "$agent" ]]; then
    print -u2 "$rb is running '$agent' — use hask to prompt it, or pick a shell pane"
    return 1
  fi

  local out; out="$(mktemp "${TMPDIR:-/tmp}/rex-hx.XXXXXX")" || return 1
  { rex send -s "$rs" -b "$rb" "{ $* ; } >'$out' 2>&1; printf '__REX_RC:%s__\n' \$? >>'$out'" &&
    rex send-key -s "$rs" -b "$rb" enter } || { rm -f "$out"; return 1 }

  local waited=0 timeout="${REX_HX_TIMEOUT:-60}"
  while ! grep -q '__REX_RC:' "$out" 2>/dev/null; do
    sleep 0.2
    (( waited += 1 ))
    if (( waited > timeout * 5 )); then
      print -u2 "hx: timed out after ${timeout}s waiting on $rb (is it at a prompt?)"
      sed '/__REX_RC:/d' "$out" >&2
      rm -f "$out"
      return 124
    fi
  done

  local rc; rc="$(sed -n 's/.*__REX_RC:\([0-9]*\)__.*/\1/p' "$out")"
  sed '/__REX_RC:/d' "$out"
  rm -f "$out"
  return "${rc:-0}"
}

# Prompt an agent pane, wait for it to settle, then print what it said.
# Returns 2 if it ends up blocked on an approval instead of answering.
#
# The prompt goes through `rex-agents prompt` (bracketed paste for multi-line
# text, then Enter). Settling is read off the state the agent reports: wait to
# see it working, then for it to stop. An agent that never reports working
# within REX_ASK_START seconds (default 15) is taken as done.
function hask() {
  local target="$1"; shift
  (( $# )) || { print -u2 "usage: hask <agent> <prompt...>"; return 1 }
  local rs rb; _r_at -a "$target" || return 1
  _r_not_self "$rb" || return 1

  rex-agents prompt "$rb" "$*" >/dev/null || return 1

  local timeout_ms="${REX_ASK_TIMEOUT:-300000}" start=$EPOCHREALTIME state seen=0
  while :; do
    state="$(_r_agent_state "$rs" "$rb")"
    [[ "$state" == working ]] && seen=1
    (( seen )) && [[ "$state" != working ]] && break
    (( ! seen && EPOCHREALTIME - start > ${REX_ASK_START:-15} )) && break
    if (( (EPOCHREALTIME - start) * 1000 > timeout_ms )); then
      print -u2 "hask: still $state after ${timeout_ms}ms; check 'rex-agents read $rb'"
      return 1
    fi
    sleep 0.5
  done
  rex capture -s "$rs" -b "$rb" --trim --unwrap | tail -n "${REX_ASK_LINES:-80}"

  [[ "$state" == blocked ]] && { print -u2 "(agent is blocked — it wants input)"; return 2 }
  return 0
}

# hspawn test "npm test -- --watch"
# Sibling pane in the current tab, focus left where it is. Splits a wide pane
# sideways and a tall one downward so repeated spawns stay usable. The command
# is typed into the new shell, so ctrl+c leaves a prompt to re-run it from.
# <name> labels the pane only until pane-labels.lua relabels it "<dir>  <title>";
# the ID printed is the handle to use.
function hspawn() {
  local name="$1"; shift
  [[ -n "$name" ]] || { print -u2 "usage: hspawn <name> [command...]"; return 1 }
  _r_guard || return 1

  local size cols rows dir
  size="$(rex block call -s "$REX_SESSION" -b "$REX_BLOCK" size 2>/dev/null |
    jq -r '"\(.columns // 0) \(.rows // 0)"')"
  cols="${size%% *}"; rows="${size##* }"
  if (( ${cols:-0} > ${rows:-0} * 2 )); then dir=right; else dir=below; fi

  local id
  id="$(rex split -s "$REX_SESSION" -b "$REX_BLOCK" --split="$dir" -c "$PWD" \
    --label "$name" --focus=false --json | jq -r '.block_ids[0] // empty')"
  [[ -n "$id" ]] || { print -u2 "hspawn: split failed"; return 1 }

  if (( $# )); then
    rex send -s "$REX_SESSION" -b "$id" "$*" && rex send-key -s "$REX_SESSION" -b "$id" enter
  fi
  print -r -- "$id ($name)"
}

function hkill() {
  local rs rb; _r_at "${1:-}" || return 1
  if [[ "$rb" == "$REX_BLOCK" ]]; then
    print -u2 "refusing to close the calling pane; pass a target explicitly"
    return 1
  fi
  rex block close -s "$rs" "$rb" >/dev/null && print -r -- "closed $rb"
}

# ce — close every other tab in this session, keeping the one the shell lives in
# and the agents session's orchestrators tab (where o runs). "This one" is the
# tab holding $REX_BLOCK, not whichever tab the app shows, so it behaves the
# same when run from a background tab. A tab whose agent is still working or
# blocked is closed too, but flagged in the output.
function ce() {
  _r_guard || return 1

  local -a rows
  rows=("${(@f)$(jq -rn --argjson v "$(rex session inspect "$REX_SESSION" --json)" \
      --argjson a "$(rex-agents --json 2>/dev/null || print '[]')" --arg self "$REX_BLOCK" '
    ($a | group_by(.window_id) | map({key: .[0].window_id, value: ([.[].state] | map(select(. == "working" or . == "blocked")) | first // "")}) | from_entries) as $busy
    | $v.windows[]
    | select(any(.layers[]?.blocks[]?; .block_id == $self) | not)
    | select((.label // "" | gsub("\u2063"; "")) != "orchestrators")
    | [.window_id, (.label // "-"), ($busy[.window_id] // "")] | @tsv')}")
  rows=(${rows:#})
  (( $#rows )) || { print -r -- "no other tabs"; return 0 }

  local row id label agent
  for row in $rows; do
    IFS=$'\t' read -r id label agent <<< "$row"
    rex window close -s "$REX_SESSION" "$id" >/dev/null || { print -u2 -- "failed to close $label ($id)"; continue }
    if [[ -n "$agent" ]]; then
      print -r -- "closed $label  [$agent]"
    else
      print -r -- "closed $label"
    fi
  done
}

# ── completion: {session}:{tab} addresses, then session names ───────
function _r_complete_targets() {
  [[ -n "${REX_SESSION:-}" ]] || return
  local tree out
  tree="$(_r_tree 2>/dev/null)" || return
  out="$(print -r -- "$tree" | jq -r "$_R_SLUG_JQ"'
    (.[] | (.label|slug) as $s | .windows[]? | "\($s):\(.label|slug)"),
    (.[] | (.label|slug) + ":")' 2>/dev/null)"
  [[ -z "$out" ]] && return
  local -a targets=(${(f)out})
  compadd -a targets
}
if (( $+functions[compdef] )); then
  compdef _r_complete_targets hd hid j hr hcap hp hs hsend hkeys hrun hwait hx hask hkill
fi
