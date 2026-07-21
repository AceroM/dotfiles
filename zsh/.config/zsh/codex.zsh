# Codex sessions in tmux — the codex twin of claude.zsh's `p` / `pa` / `ce`.
#
# Unlike claude (`claude --session-id <uuid>`), the codex CLI mints its OWN session
# uuid at launch and writes it to
#   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
# (and into that file's first `session_meta` line). So we can't stamp the id up front
# the way `_cl_tag` does. Instead we snapshot the rollout uuids that exist *before*
# launch, start codex, then discover the new rollout whose session_meta `cwd` is ours
# and stamp it onto the tmux session as the `@codex_session` user option — the codex
# analogue of `@claude_session`. That lets a future diffshub map the tmux session
# straight to its rollout (mirrors resolveTranscript in diffshub's index.ts).

_CODEX_SESSIONS="$HOME/.codex/sessions"

function _cx_tmux() {
  local sock="$1"
  shift
  if [[ -n "$sock" ]]; then
    tmux -L "$sock" "$@"
  else
    tmux "$@"
  fi
}

# Today's rollout folder — new sessions always land here (date-bucketed by codex).
function _cx_today_dir() { print -r -- "$_CODEX_SESSIONS/$(date +%Y/%m/%d)" }

# The canonical uuid embedded in a rollout filename, or "" if none.
function _cx_uuid_of() {
  local f="${1:t}"
  [[ "$f" =~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' ]] && print -r -- "$MATCH"
}

# Newline list of rollout uuids present in today's folder right now.
function _cx_uuids() {
  local dir="$(_cx_today_dir)" f
  for f in "$dir"/rollout-*.jsonl(N); do _cx_uuid_of "$f"; done
}

# Newline list of @codex_session uuids already claimed by a live tmux session — so a
# same-dir race never tags two sessions to the same rollout.
function _cx_claimed() {
  local sock="${1:-}"
  _cx_tmux "$sock" list-sessions -F '#{@codex_session}' 2>/dev/null | grep .
}

# Discover the rollout that appeared since `before` (a newline uuid snapshot) whose
# session_meta `cwd` matches `cwd`, and stamp it onto tmux session `name` as
# @codex_session. codex only writes a rollout once the FIRST turn starts (an idle
# session has no file yet), so we poll patiently — fast at first to tag prompted
# launches instantly, then once a second up to ~5 min to catch a session the user
# opens idle and prompts later. Best-effort: a session never prompted stays untagged
# (there's nothing to map yet anyway). Caps so a forgotten idle session self-exits.
function _cx_tag() {
  local name="$1" cwd="$2"
  local sock="${4:-}"
  local -A seen
  local u
  while IFS= read -r u; do [[ -n "$u" ]] && seen[$u]=1; done <<< "$3"

  local dir f uuid line1 metacwd tries=0
  while (( tries++ < 340 )); do
    # refresh per tick so a concurrent same-dir launcher's claim is respected
    local -A claimed
    while IFS= read -r u; do [[ -n "$u" ]] && claimed[$u]=1; done < <(_cx_claimed "$sock")
    dir="$(_cx_today_dir)"
    # newest-first so a same-dir race picks the freshest unseen rollout
    for f in "$dir"/rollout-*.jsonl(NOm); do
      uuid="$(_cx_uuid_of "$f")"
      [[ -z "$uuid" || -n "${seen[$uuid]}" || -n "${claimed[$uuid]}" ]] && continue
      # session_meta is line 1; pull "cwd":"..." out with plain param expansion
      line1="$(head -1 "$f" 2>/dev/null)"
      metacwd="${line1#*\"cwd\":\"}"; metacwd="${metacwd%%\"*}"
      if [[ "$metacwd" == "$cwd" ]]; then
        _cx_tmux "$sock" set-option -t "$name" @codex_session "$uuid" 2>/dev/null
        return 0
      fi
    done
    # bail early if the session itself is gone (closed before ever prompting)
    _cx_tmux "$sock" has-session -t "$name" 2>/dev/null || return 1
    (( tries < 40 )) && sleep 0.25 || sleep 1
  done
  return 1
}

# Fire _cx_tag in the background (disowned) so the caller can attach immediately.
function _cx_tag_async() { ( _cx_tag "$@" ) &! }

# Pick an unused adjective-noun tmux session name, avoiding the first letter of any
# session already running an agent (codex/claude/node) — mirrors claude.zsh's picker.
function _cx_pick_name() {
  local sock="${1:-}"
  local -a adjectives=("${SESSION_NAME_ADJECTIVES[@]}")
  local -a nouns=("${SESSION_NAME_NOUNS[@]}")

  typeset -A used_letters
  local existing cmd
  for existing in $(_cx_tmux "$sock" list-sessions -F '#S' 2>/dev/null); do
    cmd=$(_cx_tmux "$sock" display-message -p -t "$existing:0.0" '#{pane_current_command}' 2>/dev/null)
    if [[ "$cmd" == *codex* || "$cmd" == *claude* || "$cmd" == *node* || "$cmd" =~ ^[0-9]+\.[0-9]+ ]]; then
      used_letters[${existing:0:1}]=1
    fi
  done

  local name first_letter attempts=0
  while true; do
    name="${adjectives[RANDOM % ${#adjectives[@]} + 1]}-${nouns[RANDOM % ${#nouns[@]} + 1]}"
    first_letter="${name:0:1}"
    if ! _cx_tmux "$sock" has-session -t "$name" 2>/dev/null; then
      if [[ -z "${used_letters[$first_letter]}" ]] || (( attempts > 50 )); then
        break
      fi
    fi
    ((attempts++))
  done
  print -r -- "$name"
}

# Build the `direnv exec <dir> codex …` command string for a launch, shell-quoting
# each forwarded arg and, when set, the prompt. The prompt is passed as codex's
# POSITIONAL argument so codex submits it itself on boot — the "zero timing" trick
# (mirrors diffshub's newClaudeSession): a send-keys Enter raced against codex's
# bracketed-paste debounce gets swallowed, leaving the prompt sitting unsent.
function _cx_cmd() {
  local prompt="$1"; shift
  local cmd="direnv exec ${(q)PWD} codex" arg
  for arg in "$@"; do cmd+=" ${(q)arg}"; done
  [[ -n "$prompt" ]] && cmd+=" ${(q)prompt}"
  print -r -- "$cmd"
}

# Spawn a new codex session in <dir> (default $PWD) and switch the attached
# client to it. Used by tmux-nav's sidebar.
function _codex_new_here() {
  local dir="${1:-$PWD}"
  local client="${2:-}"
  local sock="${3:-}"
  local name="$(_cx_pick_name "$sock")"
  local before="$(_cx_uuids)"
  local cmd

  builtin cd "$dir" || return 1
  cmd="$(_cx_cmd "" --dangerously-bypass-approvals-and-sandbox)"
  _cx_tmux "$sock" new-session -ds "$name" -c "$dir" "$cmd"
  _cx_tag_async "$name" "$dir" "$before" "$sock"
  if [[ -n "$client" ]]; then
    _cx_tmux "$sock" switch-client -c "$client" -t "$name"
  else
    _cx_tmux "$sock" switch-client -t "$name"
  fi
}

# xc — interactive codex in a fresh tmux session, then attach. The codex twin of `p`.
# Flags/args are forwarded straight to codex (`xc -m gpt-5.1 …` picks a model). A
# prompt can come as an arg (`xc "fix the bug"`) or piped on stdin; either way codex
# auto-submits it on boot.
function xc() {
  local input=""
  if [[ ! -t 0 ]]; then
    input=$(cat)
  fi

  local name="$(_cx_pick_name)"
  local before="$(_cx_uuids)"
  tmux new-session -ds "$name" -c "$PWD" "$(_cx_cmd "$input" --dangerously-bypass-approvals-and-sandbox "$@")"
  _cx_tag_async "$name" "$PWD" "$before"
  tmux attach -t "$name"
}

# xa — like xc, but async: spins up the session on the bg server without attaching
# and echoes the session name. The codex twin of `pa`.
function xa() {
  local input=""
  if [[ ! -t 0 ]]; then
    input=$(cat)
  fi

  local name="$(_cx_pick_name bg)"
  local before="$(_cx_uuids)"
  _cx_tmux bg new-session -ds "$name" -c "$PWD" "$(_cx_cmd "$input" "$@")"
  _cx_tag_async "$name" "$PWD" "$before" bg
  print -r -- "$name"
}

# xe — autonomous codex: a detached bg session with approvals + sandbox bypassed, fed a
# first prompt. The codex twin of `ce`.
function xe() {
  local name="$(_cx_pick_name bg)"
  local before="$(_cx_uuids)"
  _cx_tmux bg new-session -ds "$name" -c "$PWD" \
    "$(_cx_cmd "$1" --dangerously-bypass-approvals-and-sandbox)"
  _cx_tag_async "$name" "$PWD" "$before" bg
}
