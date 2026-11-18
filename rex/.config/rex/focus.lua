-- Where I've been in Rex: the panes I visited, most recent first, when I last
-- looked at each one, and the tabs I've been through, kept like vim's jump
-- list. Rex keeps no such history (the app tracks its own selected session
-- and tab), so this file does.
--
-- Two writers share it. focus-history.lua is a long-running `rex do --all`
-- watcher that records every tab or pane change the server sees. The actions
-- in init.lua and actions.lua record the pane a key was pressed in, and where
-- it went, which covers what the server can't see: switching sessions in the
-- app sends no event.
--
-- cmd+o / cmd+i (tab_back / tab_forward) walk jumps. ctrl+alt+a
-- (next_agent_waiting) reads seen: an agent that finished after I last looked
-- is still waiting on me, one I've looked at since isn't. last_pane (palette
-- only) reads mru.
--
-- Loaded with require("focus") from init.lua and actions.lua, and dofile()
-- from the watcher.

local M = {}

M.FILE = (os.getenv("HOME") or "") .. "/.local/state/rex-focus.json"
local KEEP = 100

function M.load()
  local st
  local f = io.open(M.FILE, "r")
  if f then
    st = rex.json.decode(f:read("*a") or "")
    f:close()
  end
  if type(st) ~= "table" then st = {} end
  st.mru = st.mru or {} -- { { b = block_id, s = session_id }, … }, newest first
  st.seen = st.seen or {} -- block_id -> epoch seconds I last looked at it
  st.jumps = st.jumps or {} -- { { s = session_id, w = window_id }, … }, oldest first
  st.at = math.max(0, math.min(tonumber(st.at) or #st.jumps, #st.jumps))
  return st, f ~= nil
end

function M.save(st)
  local tmp = M.FILE .. ".tmp"
  local f = io.open(tmp, "w")
  if not f then return end
  f:write(rex.json.encode(st) or "{}")
  f:close()
  os.rename(tmp, M.FILE)
end

-- I'm in block_id now. The pane on top of the history is the one I just
-- left, so it was in view until now.
function M.visit(st, session_id, block_id, now)
  now = now or os.time()
  local top = st.mru[1]
  if top then st.seen[top.b] = now end
  if not block_id then return end
  for i = #st.mru, 1, -1 do
    if st.mru[i].b == block_id then table.remove(st.mru, i) end
  end
  table.insert(st.mru, 1, { b = block_id, s = session_id })
  while #st.mru > KEEP do table.remove(st.mru) end
  st.seen[block_id] = now
end

function M.forget(st, block_id)
  for i = #st.mru, 1, -1 do
    if st.mru[i].b == block_id then table.remove(st.mru, i) end
  end
  st.seen[block_id] = nil
end

-- The tab history behind cmd+o / cmd+i, kept the way vim keeps its jump list.
-- jumps holds each tab once, oldest first, and at is the one I'm on: the last,
-- unless cmd+o has walked back. Landing somewhere new from the middle moves
-- the tab I'm leaving to the end first, then the new one after it, so cmd+o
-- always goes back the way I came and passes each tab once.
local KEEP_JUMPS = 100

-- I've landed on this tab by any means but cmd+o / cmd+i.
function M.jump(st, session_id, window_id)
  local list = st.jumps
  local cur = list[st.at]
  if cur and cur.w == window_id then return end
  if cur and st.at < #list then
    table.remove(list, st.at)
    table.insert(list, cur)
  end
  for i = #list, 1, -1 do
    if list[i].w == window_id then table.remove(list, i) end
  end
  table.insert(list, { s = session_id, w = window_id })
  while #list > KEEP_JUMPS do table.remove(list, 1) end
  st.at = #list
end

-- A walk is cmd+o / cmd+i pressed in a row. The tab changes it makes reach the
-- watcher late, sometimes after the next press has moved on, and the app may
-- not have shown the last press's tab yet when the next one comes. For a
-- moment, then, the tabs a walk went through don't count as new jumps.
local WALK_SECONDS = 2

function M.walking(st, window_id)
  local w = st.walk
  return type(w) == "table" and type(w.tabs) == "table"
    and os.time() - (tonumber(w.t) or 0) <= WALK_SECONDS
    and w.tabs[window_id] == true
end

-- cmd+o (step -1) or cmd+i (step 1): move at to the next tab that way and
-- return its entry, or nil at the end of the list. alive(entry) says whether
-- the tab is still open; closed ones are dropped on the way.
function M.walk(st, step, alive)
  local list = st.jumps
  local from = list[st.at]
  local i = st.at + step
  while list[i] and not alive(list[i]) do
    table.remove(list, i)
    if step < 0 then
      i = i - 1
      st.at = st.at - 1
    end
  end
  local e = list[i]
  if not e then return nil end
  st.at = i

  local now = os.time()
  local w = st.walk
  if not (type(w) == "table" and type(w.tabs) == "table"
      and now - (tonumber(w.t) or 0) <= WALK_SECONDS) then
    w = { tabs = {} }
    st.walk = w
  end
  w.t = now
  if from then w.tabs[from.w] = true end
  w.tabs[e.w] = true
  return e
end

-- A tab closed: drop it from the tab history.
function M.forget_tab(st, window_id)
  for i = #st.jumps, 1, -1 do
    if st.jumps[i].w == window_id then
      table.remove(st.jumps, i)
      if i <= st.at then st.at = st.at - 1 end
    end
  end
  st.at = math.max(0, st.at)
end

-- A pane's tab, or nil once it's closed or taken out of its window.
function M.window_of(session_id, block_id)
  if not (session_id and block_id) then return nil end
  local function describe()
    local ok, r = pcall(rex.call, "session.describe_block",
      { session_id = session_id, block_id = block_id })
    return ok and r and r.block
  end
  local b = describe()
  if not b then
    -- Another session's blocks may need an attach first.
    pcall(rex.call, "session.attach", { session_id = session_id })
    b = describe()
  end
  return b and b.placement == "placed" and b.window_id or nil
end

-- I'm at this place now: { session_id, block_id?, window_id? }. It counts as a
-- visit to the pane and a jump to its tab.
function M.arrive(st, place)
  M.visit(st, place.session_id, place.block_id)
  local window_id = place.window_id or M.window_of(place.session_id, place.block_id)
  if window_id then M.jump(st, place.session_id, window_id) end
end

-- A move a key made: from the place it was pressed in, to where it went when
-- that's known.
function M.moved(from, to)
  local st = M.load()
  M.arrive(st, from)
  if to then M.arrive(st, to) end
  M.save(st)
end

-- "2026-11-12T11:57:12.608743-05:00" -> epoch seconds (with the fraction).
local function days_from_civil(y, m, d)
  if m <= 2 then y = y - 1 end
  local era = math.floor(y / 400)
  local yoe = y - era * 400
  local doy = math.floor((153 * ((m + 9) % 12) + 2) / 5) + d - 1
  local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
end

function M.epoch(iso)
  if type(iso) ~= "string" then return nil end
  local y, mo, d, h, mi, s, frac, tz =
    iso:match("^(%d+)%-(%d+)%-(%d+)T(%d+):(%d+):(%d+)(%.?%d*)(.*)$")
  if not y then return nil end
  local t = days_from_civil(tonumber(y), tonumber(mo), tonumber(d)) * 86400
    + tonumber(h) * 3600 + tonumber(mi) * 60 + tonumber(s) + (tonumber(frac) or 0)
  local sign, oh, om = tz:match("^([+-])(%d%d):?(%d%d)$")
  if sign then
    local off = tonumber(oh) * 3600 + tonumber(om) * 60
    t = sign == "+" and t - off or t + off
  end
  return t
end

return M
