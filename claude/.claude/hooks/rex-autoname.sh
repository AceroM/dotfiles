#!/usr/bin/env bash
# Label the Rex tab (window), or this pane (block) when the tab is shared, after the chat's subject.
#
# Stop hook for both Claude Code (~/.claude/settings.json) and Codex (~/.codex/hooks.json);
# Claude Code also runs it as an async PostToolUse hook so a chat is named mid first turn.
# It summarizes the title each agent already generates into a cached short label —
#   claude → last {"type":"ai-title"} entry in the transcript
#   codex  → thread_name for the session in ~/.codex/session_index.jsonl
#   either → the pane's terminal title (`rex block call … title`), as a fallback
#
# Rules (from ~/.claude/CLAUDE.md "Name the work after the work"):
#   - a cwd listed in REX_AUTONAME_COORDINATOR_DIRS (colon-separated, exact match; unset
#     reads ~/.config/rex-autoname/coordinator-dirs) is a coordinator: never rename anything. The hook's cwd, the agent process's cwd, and the
#     launching shell's cwd all count, so a coordinator that cd's into a worktree stays one.
#   - one chat in the tab (including editor/shell splits) → rename the tab;
#     several chats → rename this pane only, and only when nothing else owns pane labels:
#     ~/.config/rex/pane-labels.lua rewrites every pane label to "<dir>  <title>" (the chat
#     title already), so while it runs a pane rename would just be clobbered.
#     REX_AUTONAME_RENAME_PANES=auto (default: detect pane-labels.lua) | 1 | 0.
#   - only overwrite a tab label that Rex generated ("Window 1a2b3c4d"), one we set
#     ourselves, or a ticket label whose suffix is still "slot N"; leave main/coordinator
#     and anything a human or sibling set alone. Pane labels: only Rex's default ("shell")
#     or ours, so an addressable agent pane name like `prod-1234` survives.
#   - names always come from the chat topic, never the worktree's ticket branch.
#
# REX_AUTONAME=0 disables it; REX_AUTONAME_DEBUG=1 logs decisions to stderr.

set -u
trap 'printf "{}\n"' EXIT
input=$(cat)

[ "${REX_AUTONAME:-1}" = 0 ] && exit 0
[ -n "${REX_SESSION:-}" ] && [ -n "${REX_BLOCK:-}" ] || exit 0
command -v rex >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 || exit 0
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
S=$REX_SESSION
B=$REX_BLOCK

log() { [ "${REX_AUTONAME_DEBUG:-0}" = 1 ] && echo "rex-autoname: $*" >&2; return 0; }

field() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }

# Subagent turns never relabel the parent's tab.
[ -n "$(field .agent_id)" ] && exit 0
inherited_session=${CODEX_THREAD_ID:-}
session=$(field .session_id)
[ -n "$inherited_session" ] && [ "$inherited_session" != "$session" ] && exit 0

state_dir="${XDG_CACHE_HOME:-$HOME/.cache}/rex-autoname"
mkdir -p "$state_dir/early" 2>/dev/null

# PostToolUse (registered async) names a new chat during its first turn instead of
# leaving the tab as "Window 1a2b3c4d" until the first Stop. It does that once per session:
# mkdir claims the session, and the claim is dropped only while there is no title yet, so
# the next tool call retries. Stop keeps the label current from then on.
early=""
if [ "$(field .hook_event_name)" = PostToolUse ]; then
  [ -n "$session" ] || exit 0
  early="$state_dir/early/$(printf '%s' "$session" | tr -c 'A-Za-z0-9._-' '_')"
  mkdir "$early" 2>/dev/null || exit 0
else
  find "$state_dir/early" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rmdir {} + 2>/dev/null
fi

# A coordinator stays one after it cd's into a worktree: the hook's cwd follows those cd's,
# so also check the agent process's own cwd and the shell that launched it.
proc=$(rex block call -s "$S" -b "$B" process 2>/dev/null)
cwd=$(field .cwd); cwd=${cwd:-$PWD}
agent_cwd=$(printf '%s' "$proc" | jq -r '.foreground.cwd // empty' 2>/dev/null)
launch_cwd=$(printf '%s' "$proc" | jq -r '.ancestors[0].cwd // empty' 2>/dev/null)
# Unset falls back to the Herdr-era variable, then to the private list in
# ~/.config/rex-autoname/coordinator-dirs (one directory per line, ~ allowed; kept out
# of this public repo); set-but-empty means none.
coordinator_file=${XDG_CONFIG_HOME:-$HOME/.config}/rex-autoname/coordinator-dirs
coordinator_default=
[ -r "$coordinator_file" ] && coordinator_default=$(sed -e '/^[[:space:]]*$/d' -e "s|^~|$HOME|" "$coordinator_file" | paste -sd: -)
coordinator_dirs=${REX_AUTONAME_COORDINATOR_DIRS-${HERDR_AUTONAME_COORDINATOR_DIRS-$coordinator_default}}
is_coordinator() {
  [ -n "$1" ] || return 1
  case ":${coordinator_dirs}:" in
    ::) return 1 ;;
    *":${1%/}:"*) return 0 ;;
  esac
  return 1
}
if is_coordinator "$cwd" || is_coordinator "$agent_cwd" || is_coordinator "$launch_cwd"; then
  log "coordinator cwd ($cwd, agent ${agent_cwd:-?}, launched in ${launch_cwd:-?}), skipping"; exit 0
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
  # Claude: "✳ Fix the thing"; Codex: "Fix the thing | <dir>"
  title=$(rex block call -s "$S" -b "$B" title 2>/dev/null | jq -r '.title // empty' 2>/dev/null)
  title=$(printf '%s' "$title" | sed -E 's/^[^[:alnum:]]+//')
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
state="$state_dir/$(printf '%s' "$B" | tr ':/' '__')"
mine=$(cat "$state" 2>/dev/null)

window_id=$(rex block inspect -s "$S" "$B" --json 2>/dev/null | jq -r '.block.window_id // empty')
[ -n "$window_id" ] || exit 0
window=$(rex window inspect -s "$S" "$window_id" --json 2>/dev/null) || exit 0
# cmd+shift+f's invisible mark (U+2063, ~/.config/rex/dir-focus.lua) isn't part of the name;
# tab-labels.lua puts it back on the new label while the sidebar is narrowed.
current=$(printf '%s' "$window" | jq -r '.label // empty | gsub("\u2063"; "")')
pane_label=$(printf '%s' "$window" | jq -r --arg b "$B" '[.layers[]?.blocks[]? | select(.block_id == $b) | .label][0] // empty')
blocks=$(printf '%s' "$window" | jq -r '.layers[]?.blocks[]?.block_id')
pane_count=$(printf '%s\n' "$blocks" | grep -c .)
[[ "$pane_count" =~ ^[1-9][0-9]*$ ]] || exit 0

# An editor or shell beside a chat should not stop the tab following that chat: count only
# panes whose foreground program is an agent. If that inventory fails, keep the
# conservative pane-count behaviour.
chat_count=$pane_count
if [ "$pane_count" -gt 1 ]; then
  count=0; mine_is_chat=0; inventory_ok=1
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    p=$(rex block call -s "$S" -b "$b" process 2>/dev/null) && [ -n "$p" ] || { inventory_ok=0; break; }
    name=$(printf '%s' "$p" \
      | jq -r '[.foreground.argv0, .foreground.invoked_path, .foreground.path] | map(select(. != null) | split("/") | last | ltrimstr("-")) | .[]' 2>/dev/null)
    if printf '%s\n' "$name" | grep -qxE 'claude|codex'; then
      count=$((count + 1)); [ "$b" = "$B" ] && mine_is_chat=1
    fi
  done <<<"$blocks"
  [ "$inventory_ok" = 1 ] && [ "$mine_is_chat" = 1 ] && chat_count=$count
fi

short_name() { printf '%s' "$title" | python3 "$script_dir/tab-short-name.py"; }

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
  elif [ -z "$current" ] || printf '%s' "$current" | grep -qE '^Window [0-9a-f]{8}$' || [ "$current" = "$mine" ]; then
    :
  else
    log "tab label set by someone else: $current"; exit 0
  fi
  new=$(short_name); [ -n "$new" ] || exit 0
  [ "$new" = "$current" ] && exit 0
  rex window rename -s "$S" "$window_id" "$new" >/dev/null 2>&1 && printf '%s' "$new" >"$state" && log "tab → $new"
else
  rename_panes=${REX_AUTONAME_RENAME_PANES:-auto}
  if [ "$rename_panes" = auto ]; then
    if pgrep -f 'rex do .*pane-labels' >/dev/null 2>&1; then rename_panes=0; else rename_panes=1; fi
  fi
  [ "$rename_panes" = 1 ] || { log "shared tab; pane labels are managed elsewhere (pane-labels.lua)"; exit 0; }
  case "$pane_label" in
    ""|shell|zsh|bash|claude|codex) : ;;
    *) [ "$pane_label" = "$mine" ] || { log "pane label set by someone else: $pane_label"; exit 0; } ;;
  esac
  new=$(short_name); [ -n "$new" ] || exit 0
  [ "$new" = "$pane_label" ] && exit 0
  rex block rename -s "$S" "$B" "$new" >/dev/null 2>&1 && printf '%s' "$new" >"$state" && log "pane → $new"
fi
exit 0
