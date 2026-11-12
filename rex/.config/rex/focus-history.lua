-- Records every pane I land on, for cmd+o (last_pane) and ctrl+alt+a
-- (next_agent_waiting) in init.lua. The history itself lives in focus.lua's
-- file, which those actions write to as well.
--
-- The server announces a tab change (active_window_changed) and a pane focus
-- change (session_view_changed, focused_block_id moves). It says nothing when
-- the app switches sessions, which is why the actions record too.
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

-- Each session's focused pane as last seen: "window block".
local last = {}

local function check(session_id)
  local view = view_of(session_id)
  if not view then return end
  local block
  for _, w in ipairs(view.windows or {}) do
    if w.window_id == view.active_window_id then block = w.focused_block_id end
  end
  if not block then return end
  local key = view.active_window_id .. " " .. block
  if last[session_id] == key then return end
  local first = last[session_id] == nil
  last[session_id] = key
  -- The first look at a session is a snapshot, not a visit: a session an
  -- agent just created hasn't been looked at.
  if first then return end
  local st = F.load()
  F.visit(st, session_id, block)
  F.save(st)
end

rex.on("active_window_changed", function(ctx) check(ctx.session_id) end)
rex.on("session_view_changed", function(ctx) check(ctx.session_id) end)
rex.on("block_closed", function(_, ev)
  local st = F.load()
  F.forget(st, ev.block_id)
  F.save(st)
end)
rex.on("session_destroyed", function(_, ev) last[ev.session_id] = nil end)

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
