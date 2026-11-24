-- More herdr moves Rex has no built-in action for, beside init.lua's own: jumps by
-- position and by initial, walking agents, and starting one. Bound in keys.lua,
-- listed in the command palette, and callable by name from the CLI
-- (`rex do NAME k=v`) or any API client (`client.action`).
--
-- init.lua has the richer versions of three moves, and keys.lua binds those:
-- new_tab_here (tab_new_beside here also takes side=left), next_agent_waiting
-- (attention_next here has no memory of what I've seen) and tab_back / tab_forward
-- (jump_back here only knows the jumps these actions made). The jumps here still
-- go in init.lua's tab history (focus.lua), since the server doesn't hear the app
-- switch sessions.
--
-- "Session" is a herdr workspace/space and "window" is a tab, as in Rex's own API.

local TERMINAL = "com.superlogical.terminal"
local SHELL = "com.superlogical.terminal.shell"

-- Programs that count as agents: by the app they report with OSC 7501 (Claude
-- Code does by itself), or by the name they were started as.
local AGENT_APPS = { ["claude-code"] = true, codex = true }
local AGENT_PROGRAMS = { claude = true, codex = true }

-- What New starts: each agent with its permission prompts off.
local AGENT_COMMANDS = {
  claude = "claude --dangerously-skip-permissions",
  codex = "codex --yolo",
}

local function check(result, err)
  if err ~= nil then error(err, 0) end
  return result
end

local function shell_quote(s)
  return "'" .. tostring(s):gsub("'", [['\'']]) .. "'"
end

local function basename(path)
  return path and path:match("([^/]+)/*$") or nil
end

-- Sessions in sidebar order, each with its windows and blocks in tab and layout order.
local function sessions()
  return check(rex.call("session.list")).sessions or {}
end

-- Reading another session's view, and its blocks, takes an attach first.
local function view(session_id)
  return check(rex.call("session.attach", { session_id = session_id })).view or {}
end

local function each_block(v, fn)
  for _, window in ipairs(v.windows or {}) do
    for _, layer in ipairs(window.layers or {}) do
      for _, block in ipairs(layer.blocks or {}) do
        if block.creator_name == TERMINAL then
          fn(window, block)
        end
      end
    end
  end
end

local function block_call(session_id, block_id, method)
  return rex.call("block.method", { session_id = session_id, block_id = block_id, method = method })
end

-- The directory the block's shell is in. zsh doesn't report OSC 7 here, so fall
-- back to the foreground process's real cwd.
local function block_cwd(session_id, block_id)
  if not block_id then return nil end
  local pwd = block_call(session_id, block_id, "pwd")
  if pwd and pwd.pwd and pwd.pwd ~= "" then return pwd.pwd end
  local process = block_call(session_id, block_id, "process")
  return process and process.foreground and process.foreground.cwd or nil
end

-- The strongest status a program in the block reported: blocked, then finished
-- (done or error), then working, then idle. Returns the state and the app.
local RANK = { blocked = 4, done = 3, error = 3, working = 2, idle = 1 }
local function program_status(session_id, block_id)
  local result = block_call(session_id, block_id, "program_status")
  local best, app
  for _, record in ipairs(result and result.records or {}) do
    if best == nil or (RANK[record.state] or 0) > (RANK[best] or 0) then
      best = record.state
    end
    app = app or record.effective_app or record.app
  end
  return best, app
end

local function is_agent(session_id, block_id, app)
  if app and AGENT_APPS[app] then return true end
  local process = block_call(session_id, block_id, "process")
  local fg = process and process.foreground
  return fg ~= nil and AGENT_PROGRAMS[fg.argv0 or fg.name or ""] == true
end

-- Every agent across every session, in sidebar order.
local function agents()
  local out = {}
  for _, s in ipairs(sessions()) do
    each_block(view(s.session_id), function(window, block)
      local state, app = program_status(s.session_id, block.block_id)
      if is_agent(s.session_id, block.block_id, app) then
        out[#out + 1] = {
          session_id = s.session_id,
          session_label = s.label,
          window_id = window.window_id,
          window_label = window.label,
          block_id = block.block_id,
          state = state,
          app = app,
        }
      end
    end)
  end
  return out
end

-- Where the action came from: its session, window and block.
local function here(ctx)
  local where = { session_id = ctx.session_id, block_id = ctx.block_id }
  if ctx.session_id and ctx.block_id then
    each_block(view(ctx.session_id), function(window, block)
      if block.block_id == ctx.block_id then where.window_id = window.window_id end
    end)
  end
  return where
end

-- Jumps remember where they came from, so jump_back can bounce between the two
-- (herdr's last_pane, for the moves these actions make), and add both ends to
-- the tab history behind cmd+o / cmd+i (focus.lua).
local focus = require("focus")
local last_jump

local function leave(ctx, to)
  last_jump = here(ctx)
  pcall(focus.moved, last_jump, to)
end

-- The tab a session shows when it's selected without one: its active tab.
-- Only for the history, so a failed look gives nil rather than an error.
local function shown(session_id)
  local ok, v = pcall(view, session_id)
  if not ok then return nil end
  for _, window in ipairs(v.windows or {}) do
    if window.window_id == v.active_window_id then
      return { session_id = session_id, window_id = window.window_id, block_id = window.focused_block_id }
    end
  end
  return nil
end

local function focus_target(target)
  if target.block_id then
    check(rex.call("session.focus_block", { session_id = target.session_id, block_id = target.block_id }))
  elseif target.window_id then
    check(rex.call("session.focus_window", { session_id = target.session_id, window_id = target.window_id }))
  end
end

local function show(ctx, target)
  focus_target(target)
  if target.session_id ~= ctx.session_id then
    rex.client.queue("session.select", { session_id = target.session_id, window_id = target.window_id })
  end
end

-- Pulls an ID out of text: a full block:/window: ID, a bare UUID (a Claude Code
-- session), or a short hex ID with or without the block:/window: prefix
-- (block:a9ce9316, a9ce9316).
local function parse_rex_id(text)
  text = (text or ""):lower()
  local full = text:match("(block:%x+%-[%x%-]+)") or text:match("(window:%x+%-[%x%-]+)")
  if full then return full end
  local uuid = text:match("(%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x+)")
  if uuid then return uuid end
  local short = text:match("^%s*[`'\"]?(%x+)[`'\"]?%s*$")
    or text:match("block:(%x+)") or text:match("window:(%x+)")
  if short and #short >= 4 and #short <= 32 then return short end
  return nil
end

-- The Rex block running a live Claude Code session whose ID starts with id:
-- ~/.claude/sessions/<pid>.json names the session, and the pid's environment
-- holds the REX_BLOCK it was started in.
local CLAUDE_BLOCK = [[
for f in "$HOME"/.claude/sessions/*.json; do
  grep -q "\"sessionId\":\"$1" "$f" || continue
  pid=$(basename "$f" .json)
  kill -0 "$pid" 2>/dev/null || continue
  ps -E -o command= -p "$pid" | tr ' ' '\n' | sed -n 's/^REX_BLOCK=//p' | head -1
  exit 0
done]]

local function claude_session_block(id)
  if not id:match("^[%x%-]+$") or #id < 6 then return nil end
  local out = rex.exec({ "/bin/sh", "-c", CLAUDE_BLOCK, "sh", id }, { timeout = 3 })
  local block = out and out.ok and out.stdout:match("(block:[%x%-]+)")
  return block
end

local function clipboard_text()
  local clipboard = rex.exec({ "/usr/bin/pbpaste" }, { timeout = 2 })
  return clipboard and clipboard.ok and clipboard.stdout or nil
end

rex.action{
  name = "jump_to_id",
  title = "Jump to Tab or Pane ID",
  category = "Pane",
  description = "Focus a block or window by ID, or the pane running a Claude Code session. From a "
    .. "key or the palette it asks for the ID (block:…, window:…, a short suffix, or a Claude "
    .. "session ID like a9ce9316), prefilled from the clipboard.",
  keywords = "clipboard paste block window suffix focus switch goto id enter type",
  args = { id = "string?", dry_run = "boolean?" },
  run = function(ctx, args)
    local id = args.id
    if not id then
      local copied = clipboard_text()
      if ctx.origin == "key" or ctx.origin == "palette" then
        local answer = rex.ui.input{
          title = "Jump to ID",
          prompt = "Rex block/window ID or Claude session ID",
          placeholder = "a9ce9316 or block:…",
          value = parse_rex_id(copied) and copied:match("^%s*(.-)%s*$") or nil,
        }
        if type(answer) == "table" then
          if answer.cancelled then return nil end
          answer = answer.text
        end
        if answer == nil then return nil end
        id = answer
      else
        if not copied then error("Couldn't read the clipboard", 0) end
        id = copied
      end
    end
    id = parse_rex_id(id)
    if not id then error("That isn't a Rex ID or Claude session ID", 0) end
    local suffix = id:match("^%x+$")

    -- Leaving out context lets Rex resolve IDs across all sessions.
    local function resolve(query)
      local result = check(rex.call("target.resolve", { kinds = { "window", "block" }, queries = { query } })).results[1]
      return result.target, result.status
    end
    local target, status = nil, nil
    if not id:match("^%x+%-") then
      target, status = resolve(id)
      local matched_id = target and (target.block_id or target.window_id)
      if suffix and matched_id and matched_id:gsub("%-", ""):sub(-#id) ~= id then target = nil end
    end
    if not target and status ~= "ambiguous" then
      local block = claude_session_block(id)
      if block then target = resolve(block) end
    end
    if status == "ambiguous" and not target then error("That Rex ID is ambiguous. Copy the full ID instead", 0) end
    if not target then error("No tab, pane, or live Claude session matches " .. id, 0) end
    if not target.window_id then error("That pane is detached from its tab", 0) end
    if args.dry_run then return target end

    if target.session_id ~= ctx.session_id then
      check(rex.call("session.attach", { session_id = target.session_id }))
    end
    -- The app tracks its selected tab separately from the server's focus.
    if ctx.origin == "key" or ctx.origin == "palette" then
      rex.client.queue("session.select", { session_id = target.session_id, window_id = target.window_id })
    end
    focus_target(target)
    return target
  end,
}

local function jump(ctx, target)
  if target.block_id and target.block_id == ctx.block_id then return end
  leave(ctx, target)
  show(ctx, target)
end

-- The first entry after the current block, wrapping; the first when the current
-- block isn't in the list. With step -1, the one before.
local function rotate(list, block_id, step)
  if #list == 0 then return nil end
  for i, item in ipairs(list) do
    if item.block_id == block_id then
      return list[((i - 1 + step) % #list) + 1]
    end
  end
  return step > 0 and list[1] or list[#list]
end

rex.action{
  name = "session_goto",
  title = "Go to Session by Position",
  category = "Session",
  description = "Show the Nth session in the sidebar. Negative counts from the end: -1 is the last.",
  args = { index = "integer" },
  run = function(ctx, args)
    local list = sessions()
    local i = args.index < 0 and #list + args.index + 1 or args.index
    local target = list[i]
    if target and target.session_id ~= ctx.session_id then
      leave(ctx, shown(target.session_id))
      rex.client.queue("session.select", { session_id = target.session_id })
    end
  end,
}

rex.action{
  name = "session_letter",
  title = "Go to Session by Initial",
  category = "Session",
  description = "Show the first session in the sidebar whose name starts with the letter.",
  args = { letter = "string" },
  run = function(ctx, args)
    local letter = args.letter:lower()
    for _, s in ipairs(sessions()) do
      if (s.label or ""):lower():sub(1, #letter) == letter then
        if s.session_id ~= ctx.session_id then
          leave(ctx, shown(s.session_id))
          rex.client.queue("session.select", { session_id = s.session_id })
        end
        return
      end
    end
  end,
}

rex.action{
  name = "session_new_below",
  title = "New Session Below",
  category = "Session",
  description = "Open a session right below this one in the sidebar, in this pane's folder, and show it.",
  run = function(ctx)
    local cwd = block_cwd(ctx.session_id, ctx.block_id)
    local created = check(rex.call("session.create", {
      label = basename(cwd),
      initial_windows = { { layout = rex.layout.block{ flavor = SHELL, options = { cwd = cwd } } } },
    }))
    local list, after = sessions(), nil
    for i, s in ipairs(list) do
      if s.session_id == ctx.session_id then
        after = list[i + 1]
        if after and after.session_id == created.session_id then after = list[i + 2] end
      end
    end
    check(rex.call("session.move", {
      session_id = created.session_id,
      before_session_id = after and after.session_id or nil,
    }))
    leave(ctx, shown(created.session_id))
    rex.client.queue("session.select", { session_id = created.session_id })
    return { session_id = created.session_id }
  end,
}

rex.action{
  name = "tab_new_beside",
  title = "New Tab Beside This One",
  category = "Tab",
  description = "Open a shell tab right after the current one (side=left: right before it), in this pane's folder.",
  args = { side = "string?" },
  run = function(ctx, args)
    local v = view(ctx.session_id)
    local cwd = block_cwd(ctx.session_id, ctx.block_id)
    local created = check(rex.session.new_window{
      layout = rex.layout.block{ flavor = SHELL, options = { cwd = cwd } },
    })
    local before
    for i, window in ipairs(v.windows or {}) do
      if window.window_id == v.active_window_id then
        local next_window = (v.windows or {})[i + 1]
        before = args.side == "left" and window or next_window
      end
    end
    check(rex.session.move_window{
      window_id = created.window_id,
      before_window_id = before and before.window_id or nil,
    })
    return { window_id = created.window_id }
  end,
}

rex.action{
  name = "agent_next",
  title = "Next Agent",
  category = "Agents",
  description = "Focus the next Claude Code or Codex pane across every session (direction=previous: the one before).",
  args = { direction = "string?" },
  run = function(ctx, args)
    local target = rotate(agents(), ctx.block_id, args.direction == "previous" and -1 or 1)
    if not target then error("No agents are running", 0) end
    jump(ctx, target)
  end,
}

rex.action{
  name = "agent_goto",
  title = "Go to Agent by Position",
  category = "Agents",
  description = "Focus the Nth agent in sidebar order. Negative counts from the end: -1 is the last.",
  args = { index = "integer" },
  run = function(ctx, args)
    local list = agents()
    local target = list[args.index < 0 and #list + args.index + 1 or args.index]
    if target then jump(ctx, target) end
  end,
}

rex.action{
  name = "agents_status",
  title = "List Agents",
  category = "Agents",
  description = "Return every agent pane with its session, tab and program status, in sidebar order.",
  run = function()
    return { agents = agents() }
  end,
}

rex.action{
  name = "attention_next",
  title = "Next Agent Waiting on Me",
  category = "Agents",
  keywords = "blocked done attention inbox",
  description = "Focus the next blocked agent, else the next one whose finished work is still unread. "
    .. "Repeated presses rotate through them.",
  run = function(ctx)
    local blocked, finished = {}, {}
    for _, agent in ipairs(agents()) do
      if agent.state == "blocked" then
        blocked[#blocked + 1] = agent
      elseif agent.state == "done" or agent.state == "error" then
        finished[#finished + 1] = agent
      end
    end
    local target = rotate(#blocked > 0 and blocked or finished, ctx.block_id, 1)
    if not target then error("Nothing is waiting on you", 0) end
    jump(ctx, target)
    return { block_id = target.block_id, state = target.state }
  end,
}

rex.action{
  name = "jump_back",
  title = "Back to Previous Jump",
  category = "Pane",
  description = "Return to the pane the last session, agent or attention jump came from; again to go forward.",
  run = function(ctx)
    if not last_jump then error("No jump to go back to", 0) end
    local target = last_jump
    leave(ctx, target)
    show(ctx, target)
  end,
}

rex.action{
  name = "agent_new",
  title = "New Agent Tab",
  category = "Agents",
  description = "Open a tab that starts Claude Code or Codex (agent=claude|codex|shell) in a folder, "
    .. "optionally with a first prompt. The tab keeps its shell when the agent exits.",
  args = { agent = "string?", cwd = "string?", prompt = "string?" },
  run = function(ctx, args)
    local agent = args.agent or "claude"
    local command = AGENT_COMMANDS[agent]
    if agent ~= "shell" and not command then error("Unknown agent " .. agent, 0) end
    local cwd = args.cwd or block_cwd(ctx.session_id, ctx.block_id)
    local input
    if command then
      input = command
      if args.prompt and args.prompt ~= "" then input = input .. " " .. shell_quote(args.prompt) end
      input = input .. "\n"
    end
    local created = check(rex.session.new_window{
      window_label = agent ~= "shell" and agent or nil,
      layout = rex.layout.block{ flavor = SHELL, options = { cwd = cwd, initial_input = input } },
    })
    return { window_id = created.window_id, block_id = created.block_ids and created.block_ids[1] }
  end,
}

-- Recent Claude Code sessions, newest first, in Rex's picker. A session that's
-- still running in a Rex pane gets focused; any other is resumed in a new tab in
-- the folder it ran in. One shell pass gathers four kinds of lines:
--   live    SESSION_ID  REX_BLOCK  STATUS  PID   (running Claude processes)
--   file    MTIME  PATH                          (the newest transcripts)
--   meta    PATH  CWD  CUSTOM_TITLE  AI_TITLE    (one per match, from ripgrep;
--                                                 BSD grep took 5s for 40 files)
--   prompt  SESSION_ID  TEXT                     (recent prompts, for untitled ones)
local CLAUDE_RECENT = [[
n=$1
PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
for f in "$HOME"/.claude/sessions/*.json; do
  [ -e "$f" ] || continue
  pid=${f##*/}; pid=${pid%.json}
  kill -0 "$pid" 2>/dev/null || continue
  block=$(ps -E -o command= -p "$pid" | tr ' ' '\n' | sed -n 's/^REX_BLOCK=//p' | head -1)
  jq -r --arg b "$block" --arg pid "$pid" '"live\t\(.sessionId)\t\($b)\t\(.status // "")\t\($pid)"' "$f" 2>/dev/null
done
cd "$HOME/.claude/projects" 2>/dev/null || exit 0
files=$(ls -t ./*/*.jsonl 2>/dev/null | grep -v -E '^\./-+(private-)?tmp-|/agent-[^/]*$' | head -n "$n")
[ -n "$files" ] || exit 0
each() { printf '%s\n' "$files" | tr '\n' '\0' | xargs -0 "$@"; }
each stat -f 'file%t%m%t%N'
tab=$(printf '\t')
{
  each rg --no-config -a -N -o -m1 --with-filename --field-match-separator "$tab" '"cwd":"(\\.|[^"\\])*"'
  each rg --no-config -a -N -o --with-filename --field-match-separator "$tab" '"(customTitle|aiTitle)":"(\\.|[^"\\])*"'
} | awk -F '\t' '{ print "{\"path\":\"" $1 "\"," $2 "}" }' |
  jq -r 'def c: (. // "") | gsub("[\\t\\n\\r]+"; " "); "meta\t\(.path)\t\(.cwd | c)\t\(.customTitle | c)\t\(.aiTitle | c)"' 2>/dev/null
tail -n 4000 "$HOME/.claude/history.jsonl" 2>/dev/null |
  jq -r 'select(.sessionId) | "prompt\t\(.sessionId)\t\(.display | gsub("[\\t\\n\\r]+"; " ") | .[0:160])"' 2>/dev/null
]]

local function ago(seconds)
  if seconds < 60 then return "now" end
  if seconds < 3600 then return math.floor(seconds / 60) .. "m" end
  if seconds < 86400 then return math.floor(seconds / 3600) .. "h" end
  return math.floor(seconds / 86400) .. "d"
end

local function split_tabs(line)
  local fields = {}
  for field in (line .. "\t"):gmatch("([^\t]*)\t") do fields[#fields + 1] = field end
  return fields
end

local function recent_claude_sessions(limit)
  local out = rex.exec({ "/bin/sh", "-c", CLAUDE_RECENT, "sh", tostring(limit) }, { timeout = 10 })
  if not (out and out.ok) then error("Couldn't list Claude sessions: " .. tostring(out and out.stderr), 0) end
  local live, prompts, list, by_path = {}, {}, {}, {}
  for line in out.stdout:gmatch("[^\n]+") do
    local f = split_tabs(line)
    if f[1] == "live" then
      live[f[2]] = { block_id = f[3] ~= "" and f[3] or nil, status = f[4], pid = f[5] }
    elseif f[1] == "prompt" then
      prompts[f[2]] = f[3]
    elseif f[1] == "file" then
      local s = { id = f[3]:match("([^/]+)%.jsonl$"), mtime = tonumber(f[2]) or 0, title = "" }
      list[#list + 1], by_path[f[3]] = s, s
    elseif f[1] == "meta" and by_path[f[2]] then
      -- The newest title of each kind wins; a /rename title beats Claude's own.
      local s = by_path[f[2]]
      if f[3] ~= "" then s.cwd = s.cwd or f[3] end
      if f[4] ~= "" then s.custom = f[4] end
      if f[5] ~= "" then s.ai = f[5] end
    end
  end
  for _, s in ipairs(list) do s.title = s.custom or s.ai or "" end
  local home = os.getenv("HOME") or ""
  local now = os.time()
  local items, by_id = {}, {}
  for _, s in ipairs(list) do
    s.prompt = prompts[s.id]
    s.live = live[s.id]
    local title = (s.title ~= "" and s.title) or s.prompt
    if title then
      local where = s.cwd and (s.cwd:sub(1, #home) == home and "~" .. s.cwd:sub(#home + 1) or s.cwd) or "?"
      local detail = ago(now - s.mtime)
      if s.live then
        detail = (s.live.block_id and "open" or "outside Rex")
          .. (s.live.status ~= "" and (" · " .. s.live.status) or "") .. " · " .. detail
      end
      items[#items + 1] = {
        id = s.id,
        title = title,
        subtitle = where .. "  " .. s.id:sub(1, 8),
        detail = detail,
        icon = s.live and "terminal" or "clock",
      }
      by_id[s.id] = s
    end
  end
  return items, by_id
end

rex.action{
  name = "claude_recent",
  title = "Recent Claude Sessions…",
  category = "Agents",
  description = "Pick one of the most recent Claude Code sessions. One that's running in a Rex pane "
    .. "is focused; any other is resumed (claude --resume) in a new tab in its folder. "
    .. "id= skips the picker; dry_run=true returns the list.",
  keywords = "claude session resume recent history conversation agent open focus transcript",
  args = { id = "string?", limit = "integer?", dry_run = "boolean?" },
  run = function(ctx, args)
    local items, by_id = recent_claude_sessions(args.limit or 40)
    if args.dry_run then return { items = items } end
    local id = args.id
    if id then
      for full in pairs(by_id) do
        if full:sub(1, #id) == id then id = full end
      end
    else
      local why
      id, why = rex.ui.pick{
        title = "Claude",
        placeholder = "Recent sessions: filter by title, folder, or ID",
        confirm = "Open",
        items = items,
      }
      if not id then
        if why == "cancelled" then return nil end
        error("claude sessions: " .. tostring(why), 0)
      end
    end
    local s = by_id[id]
    if not s then error("No recent Claude session " .. id, 0) end

    if s.live then
      if not s.live.block_id then
        error("That session is running outside Rex (pid " .. s.live.pid .. ")", 0)
      end
      local result = check(rex.call("target.resolve", { kinds = { "block" }, queries = { s.live.block_id } })).results[1]
      local target = result and result.target
      if not (target and target.window_id) then error("Couldn't find the pane running that session", 0) end
      if target.session_id ~= ctx.session_id then
        check(rex.call("session.attach", { session_id = target.session_id }))
      end
      jump(ctx, target)
      return target
    end

    local cwd = s.cwd
    local probe = cwd and io.open(cwd, "r")
    if probe then probe:close() else
      error("Its folder is gone: " .. tostring(cwd), 0)
    end
    local created = check(rex.session.new_window{
      window_label = "claude",
      layout = rex.layout.block{ flavor = SHELL, options = {
        cwd = cwd,
        initial_input = AGENT_COMMANDS.claude .. " --resume " .. shell_quote(s.id) .. "\n",
      } },
    })
    local target = { session_id = ctx.session_id, window_id = created.window_id,
      block_id = created.block_ids and created.block_ids[1] }
    leave(ctx, target)
    -- The app tracks its selected tab apart from the server's focus.
    if ctx.origin == "key" or ctx.origin == "palette" then
      rex.client.queue("session.select", { session_id = ctx.session_id, window_id = created.window_id })
    end
    return target
  end,
}

-- The fn+shift+d popup: herdr-diff (git diff HEAD in jv) for this pane's repo, floating.
-- Only defined where that script is installed.
local home = os.getenv("HOME") or ""
local diff_script = home .. "/.local/bin/herdr-diff"
local diff_file = io.open(diff_script, "r")
if diff_file then
  diff_file:close()
  rex.action{
    name = "diff_popup",
    title = "Git Diff Popup",
    category = "Pane",
    description = "Show git diff HEAD for this pane's repository in jv, in a floating pane.",
    run = function(ctx)
      check(rex.session.new_layer{
        bounds = { 0.05, 0.05, 0.9, 0.9 },
        focus = true,
        layout = rex.layout.block{
          flavor = SHELL,
          options = { command = { diff_script }, cwd = block_cwd(ctx.session_id, ctx.block_id) },
        },
      })
    end,
  }
end

-- Shared tab wrapping for clients that keep their own keyboard across hosts.
-- This action declares no keys; each client decides how to bind it.
local function call(method, params)
  local result, err = rex.call(method, params)
  if err ~= nil then error(err, 0) end
  return result
end

-- Rex's session.focus_next_window and focus_previous_window stop at the ends. These
-- wrap around: next from the last tab goes to the first, previous from the first to
-- the last.
rex.action{
  name = "tab_cycle",
  title = "Next Tab, Wrapping",
  category = "Tab",
  description = "Show the next tab, going from the last back to the first (step=-1: the previous one).",
  args = { step = "integer?" },
  run = function(ctx, args)
    local v = call("session.view", { session_id = ctx.session_id })
    local windows = v.windows or {}
    if #windows < 2 then return end
    local current = v.active_window_id
    for _, window in ipairs(windows) do
      for _, layer in ipairs(window.layers or {}) do
        for _, block in ipairs(layer.blocks or {}) do
          if block.block_id == ctx.block_id then current = window.window_id end
        end
      end
    end
    local step = args.step or 1
    for i, window in ipairs(windows) do
      if window.window_id == current then
        local target = windows[((i - 1 + step) % #windows) + 1]
        call("session.focus_window", { session_id = ctx.session_id, window_id = target.window_id })
        return
      end
    end
  end,
}
