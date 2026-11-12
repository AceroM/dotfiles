-- More herdr moves Rex has no built-in action for, beside init.lua's own: jumps by
-- position and by initial, walking agents, and starting one. Bound in keys.lua,
-- listed in the command palette, and callable by name from the CLI
-- (`rex do NAME k=v`) or any API client (`client.action`).
--
-- init.lua has the richer versions of three moves, and keys.lua binds those:
-- new_tab_here (tab_new_beside here also takes side=left), next_agent_waiting
-- (attention_next here has no memory of what I've seen) and last_pane (jump_back
-- here only knows the jumps these actions made).
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
-- (herdr's last_pane, for the moves these actions make).
local last_jump

local function show(ctx, target)
  if target.block_id then
    check(rex.call("session.focus_block", { session_id = target.session_id, block_id = target.block_id }))
  elseif target.window_id then
    check(rex.call("session.focus_window", { session_id = target.session_id, window_id = target.window_id }))
  end
  if target.session_id ~= ctx.session_id then
    rex.client.queue("session.select", { session_id = target.session_id, window_id = target.window_id })
  end
end

local function jump(ctx, target)
  if target.block_id and target.block_id == ctx.block_id then return end
  last_jump = here(ctx)
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
      last_jump = here(ctx)
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
          last_jump = here(ctx)
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
    last_jump = here(ctx)
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
    last_jump = here(ctx)
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
