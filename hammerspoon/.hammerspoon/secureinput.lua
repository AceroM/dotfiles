-- Watches macOS Secure Input. While any process holds it, every keyboard event
-- tap goes blind: the fn shortcuts (herdrkeys, windowtiler) and the Option
-- taps (appkeys) see nothing, while hs.hotkey bindings keep working. The
-- usual stuck holders are loginwindow after a wake/unlock and Ghostty.
--
--   - a 🔒 menu bar item shows while it's on; its menu names the holder and
--     can lock the screen, which is what usually makes a stuck holder let go
--   - a toast says who holds it (click it to lock) once it looks like a leak
--     (see LEAK_SECONDS / FRONT_SECONDS), and another says when it's released
--   - every on/off, wake, lock and unlock goes to LOG with the holder and the
--     frontmost app, so the pattern behind it shows up over time:
--       tail -50 ~/.cache/hammerspoon-secure-input.log
--
-- Usage from init.lua:
--   secureinput = require("secureinput")
--   secureinput.start()

local M = {}
local toast = require("toast")

local LOG = os.getenv("HOME") .. "/.cache/hammerspoon-secure-input.log"
local POLL = 1 -- seconds; IsSecureEventInputEnabled is a cheap call
-- Typing a password (sudo in Ghostty, a browser field) holds it legitimately,
-- and then the holder is the app in front. A leak is a holder that isn't in
-- front (a Chrome tab you left, Slack, loginwindow after unlock), so toast
-- that quickly, and a holder in front only once it has outlasted any password
-- (a leaking background tab in the Chrome window you're using looks like that).
local LEAK_SECONDS = 15
local FRONT_SECONDS = 120
local ACCENT = { red = 0.9, green = 0.35, blue = 0.3 }

-- The holder's pid and process name, from the root of the IORegistry only
-- (~20ms; the full `ioreg -l` tree takes ~300ms). A pid whose process has
-- exited is the stale-flag case: only lock/unlock or logout clears that.
local HOLDER_SCRIPT = [[
pid=$(/usr/sbin/ioreg -d 1 -k IOConsoleUsers -w 0 | /usr/bin/grep -o '"kCGSSessionSecureInputPID"=[0-9]*' | /usr/bin/head -1 | /usr/bin/grep -o '[0-9]*$')
[ -n "$pid" ] || exit 0
printf '%s ' "$pid"
/bin/ps -o comm= -p "$pid" || echo "(exited)"
]]

local state = { on = false }

local function log(event, detail)
  local file = io.open(LOG, "a")
  if not file then return end
  file:write(os.date("%Y-%m-%d %H:%M:%S"), "  ", event, detail and ("  " .. detail) or "", "\n")
  file:close()
end

local function frontName()
  local app = hs.application.frontmostApplication()
  return app and (app:name() or app:bundleID()) or "?"
end

local function lookupHolder(callback)
  local task = hs.task.new("/bin/sh", function(_, stdout)
    local pid, command = (stdout or ""):match("^(%d+) (.-)%s*$")
    if not pid then return callback(nil) end
    callback({ pid = tonumber(pid), name = command:match("([^/]+)$") or command })
  end, { "-c", HOLDER_SCRIPT })
  M.task = task -- keep it alive until it answers
  task:start()
end

local function describe(holder)
  if not holder then return "an unknown process" end
  return holder.name .. " (pid " .. holder.pid .. ")"
end

local function lockScreen()
  log("lock", "requested from Hammerspoon")
  hs.caffeinate.lockScreen()
end

local function menuItems()
  return {
    { title = "Secure Input held by " .. describe(state.holder), disabled = true },
    { title = "since " .. os.date("%H:%M:%S", state.since or os.time()) .. ", fn shortcuts are dead", disabled = true },
    { title = "-" },
    { title = "Lock screen to release it", fn = lockScreen },
    { title = "Open log", fn = function() hs.task.new("/usr/bin/open", nil, { "-t", LOG }):start() end },
  }
end

local function showMenu()
  if M.menu then return end
  M.menu = hs.menubar.new()
  M.menu:setTitle("🔒")
  M.menu:setTooltip("Secure Input is on: keyboard event taps are blind")
  M.menu:setMenu(menuItems)
end

local function hideMenu()
  if M.menu then M.menu:delete() end
  M.menu = nil
end

local function warn(reason)
  lookupHolder(function(holder)
    if not state.on then return end
    state.holder = holder or state.holder
    log("stuck", describe(state.holder) .. " for " .. (os.time() - state.since) .. "s, " .. reason .. ", front: " .. frontName())
    toast.show("Held by " .. describe(state.holder) .. ". fn shortcuts are dead. Click to lock the screen; unlocking usually clears it.", {
      title = "Secure Input",
      accent = ACCENT,
      timeout = 30,
      onClick = lockScreen, -- the card dismisses itself after this
    })
  end)
end

-- true / false once the holder is known, nil while it isn't.
local function holderInFront()
  if not state.holder then return nil end
  local app = hs.application.frontmostApplication()
  return app ~= nil and app:pid() == state.holder.pid
end

local function maybeWarn()
  if state.warned then return end
  local now, inFront = os.time(), holderInFront()
  if inFront == false then
    state.awaySince = state.awaySince or now
    if now - state.awaySince < LEAK_SECONDS then return end
    state.warned = true
    warn("not in front for " .. (now - state.awaySince) .. "s")
  else
    state.awaySince = nil
    if now - state.since < FRONT_SECONDS then return end
    state.warned = true
    warn(inFront and "in front" or "holder unknown")
  end
end

local function poll()
  local on = hs.eventtap.isSecureInputEnabled()
  if on == state.on then
    if on then maybeWarn() end
    return
  end
  state.on = on
  if on then
    state.since, state.holder, state.warned, state.awaySince = os.time(), nil, false, nil
    local front = frontName()
    showMenu()
    lookupHolder(function(holder)
      state.holder = holder
      log("on", describe(holder) .. ", front: " .. front)
    end)
  else
    log("off", "after " .. (os.time() - state.since) .. "s, was " .. describe(state.holder))
    hideMenu()
    if state.warned then
      toast.show("Released. fn shortcuts work again.", { title = "Secure Input", timeout = 4 })
    end
  end
end

local POWER_EVENTS = {
  [hs.caffeinate.watcher.systemDidWake] = "wake",
  [hs.caffeinate.watcher.screensDidLock] = "screen locked",
  [hs.caffeinate.watcher.screensDidUnlock] = "screen unlocked",
  [hs.caffeinate.watcher.sessionDidBecomeActive] = "session active",
}

function M.start()
  if M.timer then M.timer:stop() end
  if M.watcher then M.watcher:stop() end
  M.timer = hs.timer.doEvery(POLL, poll)
  M.watcher = hs.caffeinate.watcher.new(function(event)
    if not POWER_EVENTS[event] then return end
    local secure = hs.eventtap.isSecureInputEnabled()
    log(POWER_EVENTS[event], "secure input " .. (secure and "on" or "off"))
  end):start()
  poll()
  return M
end

-- For the hs CLI: hs -c 'return secureinput.status()'
function M.status()
  if not state.on then return "off" end
  return "on since " .. os.date("%H:%M:%S", state.since) .. ", held by " .. describe(state.holder)
end

M.lockScreen = lockScreen

return M
