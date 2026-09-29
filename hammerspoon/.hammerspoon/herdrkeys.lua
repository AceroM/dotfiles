-- fn shortcuts for Herdr, from a raw keyDown tap (hs.hotkey can't bind fn).
--
--   fn+a / fn+s   toggle the quick agents / spaces picker (from any app)
--   fn+t          toggle the tabs picker (every tab in every space)
--   fn+;          toggle the recent Claude/Codex sessions picker; Enter
--                 resumes one in a new tab with permissions bypassed
--   fn+y          copy the focused pane's Claude/Codex session id
--   fn+x/w/o/i    become ctrl+alt+x/w/o/i in Ghostty: close tab, close pane,
--                 last pane back/forth
--   fn+h/l        become ctrl+alt+h/l in Ghostty: previous / next tab
--   fn+j/k        become ctrl+alt+j/k in Ghostty: next / previous space
--   fn+d / fn+-   become ctrl+alt+v / ctrl+alt+minus in Ghostty: split
--                 vertically / horizontally
--   fn+b          becomes ctrl+alt+b in Ghostty: toggle the sidebar
--   fn+r          becomes ctrl+alt+r in Ghostty: rename tab
--   fn+shift+r    becomes ctrl+alt+shift+r in Ghostty: rename space
--   fn+n          becomes ctrl+alt+n in Ghostty: new tab
--   fn+shift+n    becomes ctrl+alt+shift+n in Ghostty: new space
--   fn+arrows     become ctrl+alt+arrows in Ghostty: focus the pane that way.
--                 macOS has already turned fn+arrow into home/end/pgup/pgdn
--                 by the time the tap sees it, so those keycodes are mapped
--                 back to arrows (outside Ghostty they keep their usual job)
--   ctrl+alt+;    (and +shift) handled here too while Ghostty is focused, so
--                 Herdr's own binding -- a slower shell hop -- is only a fallback
--
-- Everything talks to the Herdr socket via nc: every spawned process costs
-- ~20-30ms on this machine, and the pickers used to chain nine of them.
--
-- Usage from init.lua:
--   herdrkeys = require("herdrkeys")
--   herdrkeys.start()

local M = {}

local HOME = os.getenv("HOME")
local SOCK = HOME .. "/.config/herdr/herdr.sock"
local PIDFILE = HOME .. "/.cache/herdr-quick-picker.pid"
local GHOSTTY = "com.mitchellh.ghostty"
local PLUGIN = "miguel.quick-pickers"
local WIDTH = 40 -- ~300px at font-size 14
local SESSIONS_WIDTH = 110 -- title + cwd + age
local SESSIONS_ROWS = 20 -- sessions.ts LIMIT

local keys = hs.keycodes.map
local pickers = { [keys.a] = "agents", [keys.s] = "spaces", [keys.t] = "tabs", [keys[";"]] = "sessions" }
local remapped = {
  [keys.x] = true, [keys.w] = true, [keys.o] = true, [keys.i] = true,
  [keys.h] = true, [keys.j] = true, [keys.k] = true, [keys.l] = true,
  [keys["-"]] = true, [keys.n] = true, [keys.r] = true, [keys.b] = true,
  [keys.d] = keys.v, -- fn+d -> ctrl+alt+v
  [keys.home] = keys.left, [keys["end"]] = keys.right,
  [keys.pageup] = keys.up, [keys.pagedown] = keys.down,
}
-- Keys whose shifted chord is forwarded too (fn+shift+n -> ctrl+alt+shift+n).
local shiftable = { [keys.n] = true, [keys.r] = true }

local tap
local inflight = {} -- keeps sockets alive until they answer

-- One JSON request/response over the Herdr socket. cb(response, rawLine).
-- Via `nc -U`, not hs.socket: hs.socket crashes Hammerspoon outright when it
-- connects to a unix socket (GCDAsyncSocket urlFromSockaddrUN, 1.1.1).
local function request(method, params, cb)
  local line = hs.json.encode({ id = "hs", method = method, params = params or {} })
  -- hs.json encodes an empty table as [], which Herdr rejects.
  line = line:gsub('"params":%[%]', '"params":{}')
  local task
  task = hs.task.new("/usr/bin/nc", function(_, stdout)
    inflight[task] = nil
    local raw = (stdout or ""):match("^[^\n]*")
    if cb then cb(hs.json.decode(raw) or {}, raw) end
  end, { "-U", "-w", "2", SOCK })
  inflight[task] = true
  task:setInput(line .. "\n")
  task:start()
  task:closeInput()
end

local function ghosttyFocused()
  local win = hs.window.focusedWindow()
  local app = win and win:application()
  return app ~= nil and app:bundleID() == GHOSTTY
end

local function openPicker(mode, attempt)
  request("session.snapshot", nil, function(response, raw)
    local snap = response.result and response.result.snapshot
    if not snap then return end
    local area = snap.layouts and snap.layouts[1] and snap.layouts[1].area or { width = 80, height = 24 }
    local lists = { agents = snap.agents, spaces = snap.workspaces, tabs = snap.tabs }
    local count = lists[mode] and #lists[mode] or SESSIONS_ROWS
    local width = mode == "sessions" and SESSIONS_WIDTH or WIDTH
    request("plugin.pane.open", {
      plugin_id = PLUGIN,
      entrypoint = mode,
      placement = "popup",
      focus = true,
      width = math.min(width, area.width),
      -- rows + query/count/blank/footer + border, capped at 80% of the client
      height = math.min(count + 7, math.floor(area.height * 0.8)),
      env = { QP_SNAPSHOT = raw }, -- the picker skips its own fetch
    }, function(opened)
      -- Swapping pickers can race the old popup's teardown.
      local code = opened.error and opened.error.code
      if code == "ui_busy" and (attempt or 0) < 10 then
        hs.timer.doAfter(0.02, function() openPicker(mode, (attempt or 0) + 1) end)
      end
    end)
  end)
end

-- Same key closes the picker, the other key swaps it. The pidfile is only a
-- hint: Herdr SIGKILLs popups, so it can go stale; popup.close is the truth.
local function toggle(mode)
  if not ghosttyFocused() then
    hs.task.new("/usr/bin/open", nil, { "-b", GHOSTTY }):start()
  end
  local file = io.open(PIDFILE, "r")
  local openMode = file and file:read("*l"):match("^%d+ (%a+)")
  if file then file:close() end
  if not openMode then return openPicker(mode) end
  request("popup.close", nil, function(response)
    os.remove(PIDFILE)
    if response.result and openMode == mode then return end
    openPicker(mode)
  end)
end

local function copySessionId()
  request("session.snapshot", nil, function(response)
    local snap = response.result and response.result.snapshot
    if not snap then return end
    for _, agent in ipairs(snap.agents or {}) do
      if agent.pane_id == snap.focused_pane_id then
        local session = agent.agent_session and agent.agent_session.value
        if session then
          hs.pasteboard.setContents(session)
          hs.alert.show("Copied " .. agent.agent .. " session " .. session:sub(1, 8) .. "…", 1)
          return
        end
      end
    end
    hs.alert.show("No Claude/Codex session in the focused pane", 1)
  end)
end

local function handleKey(event)
  local code = event:getKeyCode()
  local flags = event:getFlags()

  if flags.ctrl and flags.alt and not flags.cmd and code == keys[";"] then
    if not ghosttyFocused() then return false end
    toggle(flags.shift and "spaces" or "agents")
    return true
  end

  if not flags.fn or flags.cmd or flags.alt or flags.ctrl then return false end
  if flags.shift and not shiftable[code] then return false end
  local mode = pickers[code]
  if not mode and code ~= keys.y and not remapped[code] then return false end
  local autorepeat = event:getProperty(hs.eventtap.event.properties.keyboardEventAutorepeat) ~= 0

  if mode then
    if not autorepeat then toggle(mode) end
    return true
  elseif code == keys.y then
    if not autorepeat then copySessionId() end
    return true
  elseif ghosttyFocused() then
    -- Rewrite in place: Herdr sees a plain ctrl+alt+<key>.
    event:setFlags({ ctrl = true, alt = true, shift = flags.shift or nil })
    if remapped[code] ~= true then event:setKeyCode(remapped[code]) end
  end
  return false
end

function M.start()
  if tap then tap:stop() end
  tap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, handleKey)
  tap:start()
  return M
end

M.toggle = toggle
M.copySessionId = copySessionId

return M
