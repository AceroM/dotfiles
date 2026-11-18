-- Records every pane and tab I land on, for cmd+o / cmd+i (tab_back /
-- tab_forward) and ctrl+alt+a (next_agent_waiting) in init.lua. The history
-- itself lives in focus.lua's file, which those actions write to as well.
--
-- The server announces a tab change (active_window_changed) and a pane focus
-- change (session_view_changed, focused_block_id moves). It says nothing when
-- the app switches sessions, which is why the actions record too.
--
-- It also can't say which session the app is showing, and agents open and
-- close tabs in sessions I'm not looking at. So a tab change counts as a jump
-- when it's in the session I was last known to be in, or when it's a switch
-- between two tabs that were already open: a tab opening or closing elsewhere
-- isn't me moving.
--
-- Run as a long-lived script that hears every session, including new ones:
--   rex do --all ~/.config/rex/focus-history.lua

local HOME = os.getenv("HOME") or ""
local F = dofile(HOME .. "/.config/rex/focus.lua")
local TERMINAL = "com.superlogical.terminal"

-- session.view comes back empty for a session this script hasn't attached,
-- so attach each one once (see tab-labels.lua).
local attached = {}
local function view_of(session_id)
  if not attached[session_id] then
    local ok, r = pcall(rex.call, "session.attach", { session_id = session_id })
    if not ok or not r then return nil end
    attached[session_id] = true
    return r.view
  end
  local ok, view = pcall(rex.call, "session.view", { session_id = session_id })
  return ok and view or nil
end

-- Each session as last seen: its focused pane ("window block"), its active
-- tab, and the tabs it had.
local last, active, tabs = {}, {}, {}

-- Rex announces the new active tab before the tab that closed, so a tab
-- closing in another session can look like a switch for a moment. A jump
-- recorded in a session other than mine is suspect until then:
-- session_id -> { w = tab jumped to, left = tab it left, t = when }.
local suspect = {}

local function check(session_id)
  local view = view_of(session_id)
  if not view then return end
  local window, block = view.active_window_id, nil
  local open = {}
  for _, w in ipairs(view.windows or {}) do
    open[w.window_id] = true
    if w.window_id == window then block = w.focused_block_id end
  end
  if not block then return end
  local key = window .. " " .. block
  if last[session_id] == key then
    tabs[session_id] = open
    return
  end
  local first = last[session_id] == nil
  local before, had = active[session_id], tabs[session_id] or {}
  last[session_id], active[session_id], tabs[session_id] = key, window, open
  -- The first look at a session is a snapshot, not a visit: a session an
  -- agent just created hasn't been looked at.
  if first then return end
  local st = F.load()
  F.visit(st, session_id, block)
  if window ~= before and not F.walking(st, window) then
    local here = st.jumps[st.at]
    local opened_or_closed = not had[window] or (before and not open[before])
    local mine = here and here.s == session_id
    if mine or not opened_or_closed then
      F.jump(st, session_id, window)
      suspect[session_id] = not mine and before
        and { w = window, left = before, t = os.time() } or nil
    end
  end
  F.save(st)
end

rex.on("active_window_changed", function(ctx) check(ctx.session_id) end)
rex.on("session_view_changed", function(ctx) check(ctx.session_id) end)
rex.on("block_closed", function(_, ev)
  local st = F.load()
  F.forget(st, ev.block_id)
  F.save(st)
end)
rex.on("window_closed", function(ctx, ev)
  local st = F.load()
  -- The suspect jump was the tab closing, not me: take it back.
  local s = suspect[ctx.session_id]
  suspect[ctx.session_id] = nil
  if s and s.left == ev.window_id and os.time() - s.t <= 2
      and st.at == #st.jumps and (st.jumps[st.at] or {}).w == s.w then
    table.remove(st.jumps)
    st.at = #st.jumps
  end
  F.forget_tab(st, ev.window_id)
  F.save(st)
end)
rex.on("session_destroyed", function(_, ev)
  last[ev.session_id], active[ev.session_id], tabs[ev.session_id] = nil, nil, nil
  suspect[ev.session_id] = nil
end)

-- First run: count every pane that exists now as seen, so agents that
-- finished long ago don't all queue up for ctrl+alt+a at once.
local st, existed = F.load()
local now = os.time()
for _, s in ipairs(rex.call("session.list", {}).sessions or {}) do
  local view = view_of(s.session_id)
  if view and not existed then
    for _, w in ipairs(view.windows or {}) do
      for _, layer in ipairs(w.layers or {}) do
        for _, b in ipairs(layer.blocks or {}) do
          if b.creator_name == TERMINAL then st.seen[b.block_id] = now end
        end
      end
    end
  end
  check(s.session_id)
end
if not existed then F.save(st) end

-- The tab history starts from the pane history when it's empty, oldest first.
st = F.load()
if #st.jumps == 0 and #st.mru > 0 then
  for i = #st.mru, 1, -1 do
    local e = st.mru[i]
    local window_id = F.window_of(e.s, e.b)
    if window_id then F.jump(st, e.s, window_id) end
  end
  F.save(st)
end
