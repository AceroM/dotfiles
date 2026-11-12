-- Rex config. Reload with: rex config reload

-- Tabs: cmd+option+left/right move between tabs.
rex.bind("cmd+alt+left", "client.tab.previous")
rex.bind("cmd+alt+right", "client.tab.next")

-- Panes: option+arrows move focus between panes.
rex.bind("alt+left", "pane.focus.left")
rex.bind("alt+right", "pane.focus.right")
rex.bind("alt+up", "pane.focus.up")
rex.bind("alt+down", "pane.focus.down")

-- Tabs: cmd+j / cmd+k move to the next / previous tab, cmd+; closes it.
rex.bind("cmd+j", "client.tab.next")
rex.bind("cmd+k", "client.tab.previous")
rex.bind("cmd+;", "client.tab.close")

-- cmd+p is the session switcher (was cmd+k; replaces Go to Anything).
rex.bind("cmd+p", "session.switch")

local TERMINAL = "com.superlogical.terminal"

-- The directory a pane is in: its foreground program's, else its shell's,
-- else the last one it reported with OSC 7.
local function pane_cwd(block_id)
  if not block_id then return nil end
  local p = rex.block.call(TERMINAL, "process", { block_id = block_id })
  if p then
    if p.foreground and p.foreground.cwd then return p.foreground.cwd end
    for _, a in ipairs(p.ancestors or {}) do
      if a.cwd then return a.cwd end
    end
  end
  local r = rex.block.call(TERMINAL, "pwd", { block_id = block_id })
  if r and r.pwd and r.pwd ~= "" then
    local path = r.pwd:gsub("^file://[^/]*", "")
    return (path:gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end))
  end
  return nil
end

-- cmd+n opens a new tab right after the current one (not at the end), in the
-- focused pane's directory, and shows it. It's an action rather than a bound
-- function because only actions can queue client actions, and the Mac app
-- keeps its own selected tab, so it has to be told to show the new one.
rex.action{
  name = "new_tab_here",
  title = "New Tab After Current",
  category = "Tab",
  keywords = "new tab here cwd directory next",
  run = function(ctx, args)
    local view, err = rex.session.view{}
    if not view then error(err, 0) end

    local active_index, after, focused = nil, nil, ctx.block_id
    for i, w in ipairs(view.windows or {}) do
      if w.window_id == view.active_window_id then
        active_index = i
        after = view.windows[i + 1]
        focused = focused or w.focused_block_id
        break
      end
    end

    local created
    created, err = rex.session.new_window{
      focus = true,
      layout = rex.layout.block{
        flavor = TERMINAL .. ".shell",
        options = { cwd = pane_cwd(focused) },
      },
    }
    if not created then error(err, 0) end

    -- With no tab after the active one, the new tab already sits at the end.
    if after then
      rex.session.move_window{
        window_id = created.window_id,
        before_window_id = after.window_id,
      }
    end
    rex.session.focus_window{ window_id = created.window_id }

    -- Ask the app to show it too. pcall: run from the CLI there may be no
    -- client to ask.
    pcall(rex.client.queue, "session.select", {
      session_id = ctx.session_id,
      window_id = created.window_id,
    })
    return { window_id = created.window_id, index = active_index and active_index + 1 }
  end,
}
rex.bind("cmd+n", "new_tab_here")

-- ctrl+alt+a focuses the next agent waiting on me: the next blocked one, else
-- the next one whose finished work I haven't seen, across every session. It's
-- Herdr's ctrl+alt+a (~/.local/bin/herdr-agent-attention) ported to Rex.
--
-- Agents report their state to the terminal with OSC 7501, and program_status
-- reads it back. Like rex-agents, only records from the pane's foreground
-- process count, so a dead agent's last "done" doesn't linger. Presses rotate:
-- from a waiting pane the target is the next one in the queue, so two blocked
-- agents alternate instead of the first swallowing every press.
local WAITING = { blocked = 1, done = 2 }

local function agent_state(session_id, block_id)
  local function call(method)
    local ok, r = pcall(rex.call, "block.method",
      { session_id = session_id, block_id = block_id, method = method })
    return ok and r or {}
  end
  local fg = (call("process").foreground or {}).pid
  local root, first
  for _, rec in ipairs(call("program_status").records or {}) do
    local owner = (rec.owner or {}).pid
    if owner == nil or owner == fg then
      first = first or rec
      if not rec.id then root = root or rec end
    end
  end
  return ((root or first) or {}).state
end

local function waiting_agents()
  local queue = {}
  for _, s in ipairs(rex.call("session.list", {}).sessions or {}) do
    -- Reading another session's view takes an attach first.
    local view = (rex.call("session.attach", { session_id = s.session_id }) or {}).view or {}
    for _, w in ipairs(view.windows or {}) do
      for _, layer in ipairs(w.layers or {}) do
        for _, b in ipairs(layer.blocks or {}) do
          if b.creator_name == TERMINAL then
            local state = agent_state(s.session_id, b.block_id)
            if WAITING[state] then
              table.insert(queue, {
                session_id = s.session_id, window_id = w.window_id,
                block_id = b.block_id, state = state, ord = #queue,
              })
            end
          end
        end
      end
    end
  end
  table.sort(queue, function(a, b)
    if WAITING[a.state] ~= WAITING[b.state] then return WAITING[a.state] < WAITING[b.state] end
    return a.ord < b.ord
  end)
  return queue
end

rex.action{
  name = "next_agent_waiting",
  title = "Next Agent Waiting",
  category = "Pane",
  keywords = "agent attention blocked done unseen waiting next",
  run = function(ctx, args)
    local queue = waiting_agents()
    if #queue == 0 then return { verdict = "none" } end
    local target = queue[1]
    for i, a in ipairs(queue) do
      if a.block_id == ctx.block_id then
        if #queue == 1 then return { verdict = "self" } end
        target = queue[i % #queue + 1]
        break
      end
    end
    if args.dry_run then return { verdict = "go", target = target, queue = queue } end

    rex.call("session.focus_block", { session_id = target.session_id, block_id = target.block_id })
    -- The app keeps its own selected session and tab, so tell it to show the target.
    rex.client.queue("session.select", {
      session_id = target.session_id,
      window_id = target.window_id,
    })
    return { verdict = "go", target = target }
  end,
}
rex.bind("ctrl+alt+a", "next_agent_waiting")

-- cmd+shift+n opens a new session.
rex.bind("cmd+shift+n", "session.new")

-- cmd+y copies the ID of the focused pane (instead of Quick Look).
rex.bind("cmd+y", "pane.copy_id")

-- Pane headers show "<directory>  <title>": pane-labels.lua is a long-running
-- script, so start it detached, once (the [r] keeps this shell from matching).
local REX_BIN = "/Users/miguelacero/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex"
rex.exec.start({
  "/bin/sh", "-c",
  "pgrep -f '[r]ex do .*pane-labels' >/dev/null || exec '" .. REX_BIN .. "' do '"
    .. (os.getenv("HOME") or "") .. "/.config/rex/pane-labels.lua'",
}, { detach = true })
