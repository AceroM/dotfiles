-- Where I've been in Rex: the panes I visited, most recent first, and when I
-- last looked at each one. Rex keeps no such history (the app tracks its own
-- selected session and tab), so this file does.
--
-- Two writers share it. focus-history.lua is a long-running `rex do --all`
-- watcher that records every tab or pane change the server sees. The actions
-- in init.lua record the pane a key was pressed in, which covers what the
-- server can't see: switching sessions in the app sends no event.
--
-- cmd+o (last_pane) reads mru to go back. ctrl+alt+a (next_agent_waiting)
-- reads seen: an agent that finished after I last looked is still waiting on
-- me, one I've looked at since isn't.
--
-- Loaded with require("focus") from init.lua and dofile() from the watcher.

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
