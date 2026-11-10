#!/usr/bin/env bash
# Label the herdr tab (or this pane, when the tab is shared) after the chat's subject.
#
# Stop hook for both Claude Code (~/.claude/settings.json) and Codex (~/.codex/hooks.json);
# Claude Code also runs it as an async PostToolUse hook so a chat is named mid first turn.
# It summarizes the title each agent already generates into a cached short label —
#   claude → last {"type":"ai-title"} entry in the transcript
#   codex  → thread_name for the session in ~/.codex/session_index.jsonl
#   either → the pane's terminal title, as a fallback
#
# Rules (from ~/.claude/CLAUDE.md "Name the work after the work"):
#   - a cwd listed in HERDR_AUTONAME_COORDINATOR_DIRS (colon-separated, exact match) is a
#     coordinator: never rename anything. Either the session's current cwd or the pane's
#     launch cwd matching counts, so a coordinator that cd's into a worktree stays one.
#   - one chat in the tab (including editor/shell splits) → rename the tab;
#     several chats → rename this pane only.
#   - only overwrite a tab label that is herdr-generated (a bare number), one we set
#     ourselves, or a ticket label whose suffix is still "slot N"; leave main/coordinator
#     and anything a human or sibling set alone.
#   - names always come from the chat topic, never the worktree's ticket branch.
#
# HERDR_AUTONAME=0 disables it; HERDR_AUTONAME_DEBUG=1 logs decisions to stderr.

set -u
trap 'printf "{}\n"' EXIT
input=$(cat)

[ "${HERDR_AUTONAME:-1}" = 0 ] && exit 0
[ "${HERDR_ENV:-}" = 1 ] || exit 0
[ -n "${HERDR_PANE_ID:-}" ] && [ -n "${HERDR_TAB_ID:-}" ] || exit 0
command -v herdr >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 || exit 0
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

log() { [ "${HERDR_AUTONAME_DEBUG:-0}" = 1 ] && echo "herdr-autoname: $*" >&2; return 0; }

field() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }

# Subagent turns never relabel the parent's tab.
[ -n "$(field .agent_id)" ] && exit 0
inherited_session=${CODEX_THREAD_ID:-}
session=$(field .session_id)
[ -n "$inherited_session" ] && [ "$inherited_session" != "$session" ] && exit 0

state_dir="${XDG_CACHE_HOME:-$HOME/.cache}/herdr-autoname"
mkdir -p "$state_dir/early" 2>/dev/null

# PostToolUse (registered async) names a new chat during its first turn instead of
# leaving the tab numbered until the first Stop. It does that once per session: mkdir
# claims the session, and the claim is dropped only while there is no title yet, so the
# next tool call retries. Stop keeps the label current from then on.
early=""
if [ "$(field .hook_event_name)" = PostToolUse ]; then
  [ -n "$session" ] || exit 0
  early="$state_dir/early/$(printf '%s' "$session" | tr -c 'A-Za-z0-9._-' '_')"
  mkdir "$early" 2>/dev/null || exit 0
else
  find "$state_dir/early" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rmdir {} + 2>/dev/null
fi

# A coordinator stays one after it cd's into a worktree. The hook's cwd follows those
# cd's, so also check the directory the pane was launched in (Herdr's pane cwd).
pane=$(herdr pane get "$HERDR_PANE_ID" 2>/dev/null | jq -c '.result.pane // empty' 2>/dev/null)
cwd=$(field .cwd); cwd=${cwd:-$PWD}
launch_cwd=$(printf '%s' "$pane" | jq -r '.cwd // empty' 2>/dev/null)
is_coordinator() {
  [ -n "$1" ] || return 1
  case ":${HERDR_AUTONAME_COORDINATOR_DIRS:-}:" in
    ::) return 1 ;;
    *":${1%/}:"*) return 0 ;;
  esac
  return 1
}
if is_coordinator "$cwd" || is_coordinator "$launch_cwd"; then
  log "coordinator cwd ($cwd, launched in ${launch_cwd:-?}), skipping"; exit 0
fi

# --- title -------------------------------------------------------------------------
title=""
transcript=$(field .transcript_path)
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  title=$(jq -Rr 'fromjson? | select(.type == "ai-title") | .aiTitle // empty' "$transcript" 2>/dev/null | tail -1)
fi
if [ -z "$title" ] && [ -n "$session" ] && [ -f "$HOME/.codex/session_index.jsonl" ]; then
  title=$(jq -Rr --arg id "$session" 'fromjson? | select(.id == $id) | .thread_name // empty' "$HOME/.codex/session_index.jsonl" | tail -1)
fi
if [ -z "$title" ]; then
  # Claude: "✳ Fix the thing" (glyph already stripped); Codex: "Fix the thing | <dir>"
  title=$(printf '%s' "$pane" | jq -r '.terminal_title_stripped // empty' 2>/dev/null)
  title=${title%% | *}
  case "$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]')" in
    ""|"claude code"|claude|codex|*/*|*~*) title="" ;;
  esac
fi
if [ -z "$title" ]; then
  [ -n "$early" ] && rmdir "$early" 2>/dev/null
  log "no title yet"; exit 0
fi

# --- target ------------------------------------------------------------------------
state="$state_dir/$(printf '%s' "$HERDR_PANE_ID" | tr ':/' '__')"
mine=$(cat "$state" 2>/dev/null)

tab=$(herdr tab get "$HERDR_TAB_ID" 2>/dev/null) || exit 0
pane_count=$(printf '%s' "$tab" | jq -r '.result.tab.pane_count // empty')
[[ "$pane_count" =~ ^[1-9][0-9]*$ ]] || exit 0
current=$(printf '%s' "$tab" | jq -r '.result.tab.label // empty')

# An editor beside a chat should not prevent the tab from following that chat.
# If inventory is unavailable, retain the conservative pane-count behavior.
chat_count=$pane_count
if [ "$pane_count" -gt 1 ]; then
  panes=$(herdr pane list --workspace "$HERDR_WORKSPACE_ID" 2>/dev/null) || panes=""
  count=$(printf '%s' "$panes" | jq -r --arg tab "$HERDR_TAB_ID" --arg pane "$HERDR_PANE_ID" '
    [.result.panes[] | select(.tab_id == $tab)] as $panes
    | if any($panes[]; .pane_id == $pane and ((.agent // "") != "")) then
        [$panes[] | select((.agent // "") != "")] | length
      else empty end' 2>/dev/null)
  [[ "$count" =~ ^[1-9][0-9]*$ ]] && chat_count=$count
fi

if [ "$chat_count" -le 1 ]; then
  case "$current" in
    main|coordinator) log "coordinator tab label, skipping"; exit 0 ;;
  esac
  if printf '%s' "$current" | grep -qE '^[A-Z]+-[0-9]+'; then
    suffix=$(printf '%s' "$current" | sed -E 's/^[A-Z]+-[0-9]+( · )?//')
    if [ "$current" != "$mine" ] && [ -n "$suffix" ] && ! printf '%s' "$suffix" | grep -qiE '^slot [0-9]+$'; then
      log "ticket tab already summarized by someone else: $current"; exit 0
    fi
    : # Bare ticket IDs and slot placeholders may migrate to chat-topic names.
  elif [ -z "$current" ] || printf '%s' "$current" | grep -qE '^[0-9]+$' || [ "$current" = "$mine" ]; then
    :
  else
    log "tab label set by someone else: $current"; exit 0
  fi
  new=$(printf '%s' "$title" | python3 "$script_dir/herdr-short-name.py")
  [ -n "$new" ] || exit 0
  [ "$new" = "$current" ] && exit 0
  herdr tab rename "$HERDR_TAB_ID" "$new" >/dev/null 2>&1 && printf '%s' "$new" >"$state" && log "tab → $new"
else
  new=$(printf '%s' "$title" | python3 "$script_dir/herdr-short-name.py")
  [ -n "$new" ] || exit 0
  [ "$new" = "$mine" ] && exit 0
  herdr pane rename "$HERDR_PANE_ID" "$new" >/dev/null 2>&1 && printf '%s' "$new" >"$state" && log "pane → $new"
fi
exit 0
