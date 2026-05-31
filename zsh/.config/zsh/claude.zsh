function ce() {
  local s="claude-$(uuidgen | cut -d- -f1)"
  tmux new-session -d "$s" "claude --dangerously-skip-permissions"
  sleep 1
  tmux send-keys -t "$s:0.0" "$1" C-m
}

function pm() {
  local s="claude-pm-$(uuidgen | cut -d- -f1)"
  tmux new-session -ds "$s" "claude --dangerously-skip-permissions"
  sleep 2
  tmux send-keys -t "$s:0.0" "read current diffs come up with commit messsage and push"
  sleep 1
  tmux send-keys -t "$s:0.0" Enter
}

function p() {
  local -a adjectives=("${SESSION_NAME_ADJECTIVES[@]}")
  local -a nouns=("${SESSION_NAME_NOUNS[@]}")

  typeset -A used_letters
  local existing cmd
  for existing in $(tmux list-sessions -F '#S' 2>/dev/null); do
    cmd=$(tmux display-message -p -t "$existing:0.0" '#{pane_current_command}' 2>/dev/null)
    if [[ "$cmd" == *claude* || "$cmd" == *node* || "$cmd" =~ ^[0-9]+\.[0-9]+ ]]; then
      used_letters[${existing:0:1}]=1
    fi
  done

  local name first_letter attempts=0
  while true; do
    name="${adjectives[RANDOM % ${#adjectives[@]} + 1]}-${nouns[RANDOM % ${#nouns[@]} + 1]}"
    first_letter="${name:0:1}"
    if ! tmux has-session -t "$name" 2>/dev/null; then
      if [[ -z "${used_letters[$first_letter]}" ]] || (( attempts > 50 )); then
        break
      fi
    fi
    ((attempts++))
  done
  tmux new-session -ds "$name" "claude"
  tmux attach -t "$name"
}

function tn() {
  local -a adjectives=("${SESSION_NAME_ADJECTIVES[@]}")
  local -a nouns=("${SESSION_NAME_NOUNS[@]}")

  typeset -A used_letters
  local existing cmd
  for existing in $(tmux list-sessions -F '#S' 2>/dev/null); do
    cmd=$(tmux display-message -p -t "$existing:0.0" '#{pane_current_command}' 2>/dev/null)
    if [[ "$cmd" == *claude* || "$cmd" == *node* || "$cmd" =~ ^[0-9]+\.[0-9]+ ]]; then
      used_letters[${existing:0:1}]=1
    fi
  done

  local name first_letter attempts=0
  while true; do
    name="${adjectives[RANDOM % ${#adjectives[@]} + 1]}-${nouns[RANDOM % ${#nouns[@]} + 1]}"
    first_letter="${name:0:1}"
    if ! tmux has-session -t "$name" 2>/dev/null; then
      if [[ -z "${used_letters[$first_letter]}" ]] || (( attempts > 50 )); then
        break
      fi
    fi
    ((attempts++))
  done
  tmux new-session -ds "$name" -c "$PWD"
  tmux attach -t "$name"
}

function cu() {
  local stats=~/.claude/stats-cache.json
  if [[ ! -f "$stats" ]]; then
    echo "No stats found at $stats"
    return 1
  fi

  python3 - "$stats" ~/.claude/rate-limits.json <<'PYEOF'
import json, sys, datetime, os

with open(sys.argv[1]) as f:
    data = json.load(f)

rate_limits = None
rl_path = sys.argv[2]
if os.path.exists(rl_path):
    try:
        with open(rl_path) as f:
            rate_limits = json.load(f)
    except: pass

BOLD="\033[1m"
DIM="\033[2m"
CYAN="\033[36m"
GREEN="\033[32m"
YELLOW="\033[33m"
MAGENTA="\033[35m"
RED="\033[31m"
RESET="\033[0m"
BAR_FULL="█"
BAR_EMPTY="░"

def bar(value, max_val, width=40):
    if max_val == 0:
        return BAR_EMPTY * width
    filled = int((value / max_val) * width)
    return BAR_FULL * filled + BAR_EMPTY * (width - filled)

def pct_bar(pct, width=30):
    filled = int((pct / 100) * width)
    color = GREEN if pct < 50 else YELLOW if pct < 80 else RED
    return f"{color}{BAR_FULL * filled}{DIM}{BAR_EMPTY * (width - filled)}{RESET}"

def fmt_tokens(n):
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}K"
    return str(n)

print(f"\n{BOLD}{CYAN}  Claude Code Usage{RESET}")
print(f"{DIM}  {'─'*50}{RESET}\n")

# Rate limits (live data from status line)
if rate_limits:
    five = rate_limits.get("five_hour")
    seven = rate_limits.get("seven_day")
    updated = rate_limits.get("updated_at")
    has_data = five or seven
    if has_data:
        print(f"  {BOLD}Current Limits{RESET}")
        if five:
            pct = five.get("used_percentage", 0)
            resets = five.get("resets_at", 0)
            reset_str = datetime.datetime.fromtimestamp(resets).strftime("%-I%p") if resets else "?"
            print(f"  Session (5h)  {pct_bar(pct)} {pct:.0f}% used")
            print(f"  {DIM}Resets {reset_str}{RESET}")
        if seven:
            pct = seven.get("used_percentage", 0)
            resets = seven.get("resets_at", 0)
            reset_str = datetime.datetime.fromtimestamp(resets).strftime("%b %d %-I%p") if resets else "?"
            print(f"  Weekly  (7d)  {pct_bar(pct)} {pct:.0f}% used")
            print(f"  {DIM}Resets {reset_str}{RESET}")
        if updated:
            age_min = (datetime.datetime.now().timestamp() - updated) / 60
            if age_min < 1:
                age_str = "just now"
            elif age_min < 60:
                age_str = f"{age_min:.0f}m ago"
            else:
                age_str = f"{age_min/60:.1f}h ago"
            print(f"  {DIM}Updated {age_str}{RESET}")
        print()
else:
    print(f"  {DIM}No live rate limit data yet (starts after first Claude Code session){RESET}\n")

# Totals
total_msgs = data.get("totalMessages", 0)
total_sessions = data.get("totalSessions", 0)
first_date = data.get("firstSessionDate", "")[:10]
print(f"  {BOLD}Overall{RESET}")
print(f"  Sessions: {GREEN}{total_sessions}{RESET}    Messages: {GREEN}{total_msgs}{RESET}    Since: {DIM}{first_date}{RESET}\n")

# Model usage
model_usage = data.get("modelUsage", {})
if model_usage:
    print(f"  {BOLD}Token Usage by Model{RESET}")
    for model, usage in model_usage.items():
        short = model.replace("claude-", "").replace("-2025", " ").replace("-2026", " ").split()[0]
        inp = usage.get("inputTokens", 0)
        out = usage.get("outputTokens", 0)
        cache_read = usage.get("cacheReadInputTokens", 0)
        cache_write = usage.get("cacheCreationInputTokens", 0)
        total = inp + out + cache_read + cache_write
        print(f"  {MAGENTA}{short:>12}{RESET}  in:{fmt_tokens(inp):>6}  out:{fmt_tokens(out):>6}  cache_r:{fmt_tokens(cache_read):>6}  cache_w:{fmt_tokens(cache_write):>6}  {DIM}total:{fmt_tokens(total)}{RESET}")
    print()

# Recent daily activity (last 14 days)
daily = data.get("dailyActivity", [])
if daily:
    recent = daily[-14:]
    max_msgs = max(d["messageCount"] for d in recent) if recent else 1
    print(f"  {BOLD}Recent Activity (last {len(recent)} days){RESET}")
    for d in recent:
        date = d["date"][5:]  # MM-DD
        msgs = d["messageCount"]
        sess = d["sessionCount"]
        tools = d["toolCallCount"]
        print(f"  {DIM}{date}{RESET} {CYAN}{bar(msgs, max_msgs, 30)}{RESET} {msgs:>5} msgs  {sess:>2} sess  {tools:>3} tools")
    print()

# Peak hours
hours = data.get("hourCounts", {})
if hours:
    max_h = max(hours.values()) if hours else 1
    print(f"  {BOLD}Peak Hours{RESET}")
    sorted_hours = sorted(hours.items(), key=lambda x: int(x[0]))
    line = "  "
    for h, c in sorted_hours:
        h_int = int(h)
        label = f"{h_int:02d}"
        line += f"{DIM}{label}{RESET}:{YELLOW}{c:>3}{RESET} "
    print(line)
    print()

# Longest session
longest = data.get("longestSession", {})
if longest:
    dur_ms = longest.get("duration", 0)
    dur_h = dur_ms / 3_600_000
    msgs = longest.get("messageCount", 0)
    print(f"  {BOLD}Longest Session{RESET}")
    print(f"  {dur_h:.1f}h with {msgs} messages")
    print()

PYEOF
}

function cl() {
  python3 - ~/.claude/rate-limits.json <<'PYEOF'
import json, sys, os, datetime

BOLD="\033[1m"
DIM="\033[2m"
CYAN="\033[36m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"
BAR_FULL="█"
BAR_EMPTY="░"

def pct_bar(pct, width=30):
    filled = int((pct / 100) * width)
    color = GREEN if pct < 50 else YELLOW if pct < 80 else RED
    return f"{color}{BAR_FULL * filled}{DIM}{BAR_EMPTY * (width - filled)}{RESET}"

path = sys.argv[1]
if not os.path.exists(path):
    print(f"  {DIM}No rate limit data yet (starts after first Claude Code session){RESET}")
    sys.exit(0)

with open(path) as f:
    rl = json.load(f)

five = rl.get("five_hour")
seven = rl.get("seven_day")
updated = rl.get("updated_at")

if not five and not seven:
    print(f"  {DIM}No rate limit data yet{RESET}")
    sys.exit(0)

print()
if five:
    pct = five.get("used_percentage", 0)
    resets = five.get("resets_at", 0)
    reset_str = datetime.datetime.fromtimestamp(resets).strftime("%-I%p") if resets else "?"
    print(f"  {BOLD}Session (5h){RESET}  {pct_bar(pct)} {pct:.0f}%  {DIM}resets {reset_str}{RESET}")
if seven:
    pct = seven.get("used_percentage", 0)
    resets = seven.get("resets_at", 0)
    reset_str = datetime.datetime.fromtimestamp(resets).strftime("%b %d %-I%p") if resets else "?"
    print(f"  {BOLD}Weekly  (7d){RESET}  {pct_bar(pct)} {pct:.0f}%  {DIM}resets {reset_str}{RESET}")
if updated:
    age_min = (datetime.datetime.now().timestamp() - updated) / 60
    if age_min < 1:
        age_str = "just now"
    elif age_min < 60:
        age_str = f"{age_min:.0f}m ago"
    else:
        age_str = f"{age_min/60:.1f}h ago"
    print(f"  {DIM}Updated {age_str}{RESET}")
print()
PYEOF
}

function rl() {
  local cfg="${1:-dev}"
  tmux new-session -ds repl "doppler -c $cfg run -- bun repl"
  sleep 1
  tmux send-keys -t repl ".load out/load.ts" C-m
  tmux attach -t repl
}
