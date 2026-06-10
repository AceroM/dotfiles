function ce() {
  local s="claude-$(uuidgen | cut -d- -f1)"
  tmux new-session -d "$s" -c "$PWD" "CLAUDE_CODE_NO_FLICKER=1 direnv exec '$PWD' claude --dangerously-skip-permissions"
  sleep 1
  tmux send-keys -t "$s:0.0" "$1" C-m
}

function pm() {
  local s="claude-pm-$(uuidgen | cut -d- -f1)"
  local prompt='Review the staged + unstaged diff and the recent git log for style. Write a Conventional Commits message (type(scope): summary, with a body if the change warrants it) that accurately describes the change — never use a placeholder like "changes". Then commit and push. Do NOT add a Co-Authored-By footer or any AI attribution.'
  tmux new-session -ds "$s" -c "$PWD" "CLAUDE_CODE_NO_FLICKER=1 direnv exec '$PWD' claude --dangerously-skip-permissions -p $(printf '%q' "$prompt")"
}

function j() {
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
  tmux new-session -ds "$name" -c "$PWD" "CLAUDE_CODE_NO_FLICKER=1 direnv exec '$PWD' claude"
  sleep 1
  tmux send-keys -t "$name:0.0" "$1" C-m
  tmux send-keys -t "$name:0.0" C-m
}

function p() {
  local input=""
  if [[ ! -t 0 ]]; then
    input=$(cat)
  fi

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
  local claude_cmd="CLAUDE_CODE_NO_FLICKER=1 direnv exec '$PWD' claude"
  local arg
  for arg in "$@"; do
    claude_cmd+=" ${(q)arg}"
  done
  tmux new-session -ds "$name" -c "$PWD" "$claude_cmd"
  if [[ -n "$input" ]]; then
    sleep 1
    printf '%s' "$input" | tmux load-buffer -
    tmux paste-buffer -t "$name:0.0"
    tmux send-keys -t "$name:0.0" Enter
  fi
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
  tmux -L bg new-session -ds repl "doppler -c $cfg run -- bun repl"
  sleep 1
  tmux -L bg send-keys -t repl ".load out/load.ts" C-m
  tmux -L bg attach -t repl
}

# my spend — Claude tokens + $ spent. usage: ms [name] [lookback]
#   ms                 -> today (miguel), falls back to latest day if not reported yet
#   ms miguel 1w       -> last 7 days, per-day breakdown + total
#   ms gregg 1d|2w|1m  -> lookback units: d=day w=week m=month y=year
function ms() {
  if [[ -z "$ANTHROPIC_ADMIN_API_KEY" ]]; then
    echo "ANTHROPIC_ADMIN_API_KEY is not set"
    return 1
  fi

  WHO="${1:-miguel}" LOOKBACK="${2:-}" bun run - <<'TSEOF'
const BASE = "https://api.anthropic.com/v1";
const KEY = process.env.ANTHROPIC_ADMIN_API_KEY;
const WHO = (process.env.WHO ?? "miguel").toLowerCase();
const LB = (process.env.LOOKBACK ?? "").trim();
const headers = { "x-api-key": KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
const C = { bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", reset: "\x1b[0m" };

function pricing(model) {
  const m = (model ?? "").toLowerCase();
  if (m.includes("opus")) return { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75 };
  if (m.includes("haiku")) return { input: 0.8, output: 4, cache_read: 0.08, cache_creation: 1 };
  return { input: 3, output: 15, cache_read: 0.3, cache_creation: 3.75 }; // sonnet / default
}
const groupName = (k) => k.match(/^claude_code_key_(.+)_[a-z]{4}$/)?.[1] ?? k;
const fmt = (n) => n.toLocaleString("en-US");
const fmtT = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : "" + n;

// parse lookback like 1d / 7d / 1w / 2w / 1m / 1y -> number of calendar days
const UNIT = { d: 1, w: 7, m: 30, y: 365 };
const lbm = LB.match(/^(\d+)\s*([dwmy])$/i);
if (LB && !lbm) { console.error(`bad lookback "${LB}" — use e.g. 1d, 7d, 1w, 2w, 1m, 1y`); process.exit(1); }
const windowMode = !!lbm;
const spanDays = lbm ? parseInt(lbm[1], 10) * UNIT[lbm[2].toLowerCase()] : 1;

// fetch window: window mode covers spanDays (incl today); today mode grabs 2 days for lag fallback
const now = new Date();
const backDays = windowMode ? spanDays - 1 : 2;
const start = new Date(now);
start.setUTCDate(start.getUTCDate() - backDays);
start.setUTCHours(0, 0, 0, 0);
const params = new URLSearchParams({
  bucket_width: "1d", "group_by[]": "api_key_id",
  starting_at: start.toISOString(), ending_at: now.toISOString(), limit: "31",
});

const buckets = [];
let page = null, guard = 0;
while (guard++ < 50) {
  const res = await fetch(`${BASE}/organizations/usage_report/messages?${params}${page ? `&page=${page}` : ""}`, { headers });
  if (!res.ok) { console.error(`Usage API ${res.status}: ${await res.text()}`); process.exit(1); }
  const j = await res.json();
  buckets.push(...j.data);
  if (!j.has_more || !j.next_page) break;
  page = j.next_page;
}

// map key id -> name
const keys = [];
let after = null; guard = 0;
while (guard++ < 50) {
  const kp = new URLSearchParams({ limit: "100" });
  if (after) kp.set("after_id", after);
  const res = await fetch(`${BASE}/organizations/api_keys?${kp}`, { headers });
  if (!res.ok) { console.error(`API Keys ${res.status}: ${await res.text()}`); process.exit(1); }
  const j = await res.json();
  keys.push(...j.data);
  if (!j.has_more || !j.last_id) break;
  after = j.last_id;
}
const nameMap = new Map(keys.map((k) => [k.id, k.name]));

// aggregate WHO's usage per day
const byDay = new Map();
for (const b of buckets) {
  const date = b.starting_at.slice(0, 10);
  for (const r of b.results) {
    if (!groupName(nameMap.get(r.api_key_id) ?? "").toLowerCase().includes(WHO)) continue;
    const pr = pricing(r.model);
    const inp = r.uncached_input_tokens ?? 0, out = r.output_tokens ?? 0, cr = r.cache_read_input_tokens ?? 0;
    const cc = (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) + (r.cache_creation?.ephemeral_5m_input_tokens ?? 0);
    let d = byDay.get(date);
    if (!d) { d = { inp: 0, out: 0, cr: 0, cc: 0, cost: 0 }; byDay.set(date, d); }
    d.inp += inp; d.out += out; d.cr += cr; d.cc += cc;
    d.cost += (inp * pr.input + out * pr.output + cr * pr.cache_read + cc * pr.cache_creation) / 1e6;
  }
}

const { bold, dim, cyan, green, yellow, reset } = C;
const today = now.toISOString().slice(0, 10);
const dash = (n) => dim + "─".repeat(n) + reset;
const breakdown = (d) => {
  console.log(`  Input (uncached)  ${fmt(d.inp)}`);
  console.log(`  Output            ${fmt(d.out)}`);
  console.log(`  Cache read        ${fmt(d.cr)}`);
  console.log(`  Cache creation    ${fmt(d.cc)}`);
  console.log(`  ${dash(34)}`);
  console.log(`  ${bold}Total tokens${reset}      ${green}${fmt(d.inp + d.out + d.cr + d.cc)}${reset}`);
  console.log(`  ${bold}Cost${reset}              ${green}$${d.cost.toFixed(2)}${reset}  ${dim}(~Sonnet est; API model=null)${reset}`);
};

console.log(`\n  ${bold}${cyan}${WHO} — Claude spend${reset}`);

if (windowMode) {
  const rangeStart = start.toISOString().slice(0, 10);
  const days = [...byDay.entries()].filter(([dt]) => dt >= rangeStart).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  console.log(`  ${dim}last ${spanDays} day${spanDays > 1 ? "s" : ""} (${rangeStart} → ${today})${reset}\n`);
  if (!days.length) { console.log(`  ${dim}No usage found for "${WHO}" in this window.${reset}\n`); process.exit(0); }
  const sum = { inp: 0, out: 0, cr: 0, cc: 0, cost: 0 };
  for (const [dt, d] of days) {
    const tok = d.inp + d.out + d.cr + d.cc;
    console.log(`  ${dim}${dt}${reset}  ${fmtT(tok).padStart(7)} tok  ${green}$${d.cost.toFixed(2)}${reset}`);
    sum.inp += d.inp; sum.out += d.out; sum.cr += d.cr; sum.cc += d.cc; sum.cost += d.cost;
  }
  if (!byDay.has(today)) console.log(`  ${dim}${yellow}(today not reported yet)${reset}`);
  console.log(`  ${dash(34)}`);
  breakdown(sum);
  console.log("");
} else {
  let date = today, d = byDay.get(today), lagged = false;
  if (!d) {
    const all = [...byDay.keys()].sort();
    date = all[all.length - 1];
    d = date ? byDay.get(date) : null;
    lagged = true;
  }
  if (!d) { console.log(`  ${dim}No usage found for "${WHO}" in the last few days.${reset}\n`); process.exit(0); }
  if (lagged) console.log(`  ${yellow}today (${today}) not reported yet — showing latest day${reset}`);
  console.log(`  ${dim}${date}${reset}\n`);
  breakdown(d);
  console.log("");
}
TSEOF
}
