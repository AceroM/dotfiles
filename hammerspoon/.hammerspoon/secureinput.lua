-- Watches macOS Secure Input. While any process holds it, every keyboard event
-- tap goes blind: the fn shortcuts (herdrkeys, windowtiler) and the Option
-- taps (appkeys) see nothing, while hs.hotkey bindings keep working. The
-- usual stuck holders are loginwindow after a wake/unlock and Ghostty.
--
--   - a 🔒 menu bar item shows while it's on; its menu names the holder.
--     On the laptop a full menu bar hides it behind the notch, so a red pill
--     also shows just under the notch; cmd-drag the 🔒 right of the notch
--     once and its autosaved spot sticks
--   - clicking the pill (or the toast, or "Release it" in the menu) runs
--     release(): an app only lets go once it's back in front, so it fronts
--     what turned it on. For Chrome that's the tab that was in front then
--     (a page with password-like fields, e.g. masked bank account numbers),
--     then each window's tab in turn, and afterwards it puts tabs, windows
--     and focus back. Lock/unlock never clears a Chrome leak; it's still the
--     fallback for loginwindow, a stale pid, or an app that didn't let go
--   - a toast says who holds it once it looks like a leak (see LEAK_SECONDS /
--     FRONT_SECONDS), and another says when it's released
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
local FONT = "Berkeley Mono" -- toast.lua's
local PILL = { w = 250, h = 24, label = "🔒 Secure Input · click to fix" }
local CHROME = "com.google.Chrome"
local SETTLE = 1 -- seconds to let Secure Input drop after fronting something

-- AppleScript for Chrome, run by osascript off Hammerspoon's thread (a busy
-- Chrome can sit on an Apple event for a long time). Ids are Chrome's window
-- and tab ids, stable for the window's or tab's life.
local CHROME_FRONT_TAB = [[
tell application id "com.google.Chrome"
  set t to active tab of front window
  return ((id of front window) as text) & " " & ((id of t) as text) & " " & (URL of t)
end tell]]
local CHROME_WINDOWS = [[
tell application id "com.google.Chrome"
  set out to ""
  repeat with w in windows
    set out to out & ((id of w) as text) & " " & ((id of active tab of w) as text) & linefeed
  end repeat
  return out
end tell]]
-- argv: window, tab to make active in it, window to raise, "1" to activate
local CHROME_SHOW = [[
on run argv
  set {wid, tid, raiseId, doActivate} to argv
  tell application id "com.google.Chrome"
    try
      set w to window id (wid as integer)
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        if ((id of t) as text) is tid then set active tab index of w to i
      end repeat
    end try
    try
      set index of window id (raiseId as integer) to 1
    end try
    if doActivate is "1" then activate
  end tell
end run]]

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

local function frontName(app)
  app = app or hs.application.frontmostApplication()
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

local scripts = {} -- running osascript tasks, kept alive until they answer
local function osascript(source, args, callback)
  local argv = { "-e", source }
  for _, arg in ipairs(args or {}) do argv[#argv + 1] = tostring(arg) end
  local task
  task = hs.task.new("/usr/bin/osascript", function(code, stdout)
    scripts[task] = nil
    if callback then callback(code == 0 and (stdout or ""):gsub("%s+$", "") or nil) end
  end, argv)
  scripts[task] = true
  task:start()
end

local function setPillLabel(label)
  if not M.pill then return end
  M.pill[2].text = hs.styledtext.new(label, {
    font = { name = FONT, size = 12 },
    color = { white = 1 },
    paragraphStyle = { alignment = "center" },
  })
end

-- Fronts each step in turn, giving Secure Input SETTLE seconds to drop after
-- each, and stops at the first that releases it. done(released).
local function tryInTurn(steps, front, done)
  local i = 0
  local function nextStep()
    if not hs.eventtap.isSecureInputEnabled() then return done(true) end
    i = i + 1
    if i > #steps then return done(false) end
    front(steps[i])
    M.settle = hs.timer.doAfter(SETTLE, nextStep)
  end
  nextStep()
end

-- Chrome lets go once the page that turned it on is the active tab of its
-- front window again. That's the tab in front when it turned on, if Chrome
-- was in front then; otherwise try each window's active tab. Afterwards the
-- tab, the front window and the app you were in come back.
local function releaseChrome(prevFront, done)
  osascript(CHROME_WINDOWS, nil, function(out)
    local windows, activeTab = {}, {}
    for wid, tid in (out or ""):gmatch("(%d+) (%d+)") do
      windows[#windows + 1] = { wid, tid }
      activeTab[wid] = tid
    end
    if #windows == 0 then return done(false, "no Chrome windows") end
    local origin = state.chromeTab
    local steps = {}
    if origin and activeTab[origin.window] then
      steps[1] = { origin.window, origin.tab }
    end
    for _, w in ipairs(windows) do
      if not (origin and w[1] == origin.window and w[2] == origin.tab) then steps[#steps + 1] = w end
    end
    tryInTurn(steps, function(step)
      osascript(CHROME_SHOW, { step[1], step[2], step[1], "1" })
    end, function(released)
      local back = origin and activeTab[origin.window] and origin.window or windows[1][1]
      local backToChrome = prevFront and prevFront:bundleID() == CHROME
      osascript(CHROME_SHOW, { back, activeTab[back], windows[1][1], backToChrome and "1" or "0" }, function()
        if prevFront and not backToChrome then prevFront:activate() end
        done(released, origin and origin.url or "each Chrome window")
      end)
    end)
  end)
end

local function release()
  if not state.on or state.releasing then return end
  state.releasing, state.announce = true, true
  setPillLabel("🔒 Releasing…")
  local prevFront = hs.application.frontmostApplication()
  local app = state.holder and hs.application.applicationForPID(state.holder.pid)

  local function finish(released, what)
    state.releasing = false
    log(released and "released" or "not released", "by fronting " .. what)
    if not released then setPillLabel(PILL.label) end
  end

  if app and app:bundleID() == CHROME then
    releaseChrome(prevFront, function(released, what)
      finish(released, what)
      if released then return end
      toast.show("Fronting Chrome's tabs didn't release it. Click to lock the screen; unlocking sometimes clears it.", {
        title = "Secure Input",
        accent = ACCENT,
        timeout = 30,
        onClick = lockScreen,
      })
    end)
  elseif app and app:kind() == 1 and not (prevFront and prevFront:pid() == app:pid()) then
    tryInTurn({ app }, function(a) a:activate() end, function(released)
      if prevFront then prevFront:activate() end
      finish(released, app:name() or describe(state.holder))
      if not released then lockScreen() end
    end)
  else
    -- loginwindow, a pid that has exited, or the app already in front
    state.releasing = false
    lockScreen()
  end
end

local function menuItems()
  return {
    { title = "Secure Input held by " .. describe(state.holder), disabled = true },
    { title = "since " .. os.date("%H:%M:%S", state.since or os.time()) .. ", fn shortcuts are dead", disabled = true },
    { title = "-" },
    { title = "Release it", fn = release },
    { title = "Lock screen", fn = lockScreen },
    { title = "Open log", fn = function() hs.task.new("/usr/bin/open", nil, { "-t", LOG }):start() end },
  }
end

-- Centered under the menu bar of the screen in front, which on the laptop is
-- right below the notch. Never takes focus; a click runs release().
local function showPill()
  if M.pill then return end
  local f = hs.screen.mainScreen():frame() -- excludes the menu bar
  local pill = hs.canvas.new({ x = f.x + (f.w - PILL.w) / 2, y = f.y + 4, w = PILL.w, h = PILL.h })
  pill:level(hs.canvas.windowLevels.overlay)
  pill:behavior({ "canJoinAllSpaces", "stationary" })
  pill:clickActivating(false)
  pill[1] = {
    type = "rectangle",
    action = "fill",
    fillColor = { red = ACCENT.red, green = ACCENT.green, blue = ACCENT.blue, alpha = 0.95 },
    roundedRectRadii = { xRadius = PILL.h / 2, yRadius = PILL.h / 2 },
    trackMouseDown = true,
  }
  pill[2] = {
    type = "text",
    text = hs.styledtext.new(PILL.label, {
      font = { name = FONT, size = 12 },
      color = { white = 1 },
      paragraphStyle = { alignment = "center" },
    }),
    frame = { x = 0, y = 4, w = PILL.w, h = PILL.h - 4 },
  }
  pill:mouseCallback(function(_, message)
    if message == "mouseDown" then release() end
  end)
  pill:show()
  M.pill = pill
end

local function showMenu()
  if not M.menu then
    -- The autosave name keeps a cmd-dragged position across on/off.
    M.menu = hs.menubar.new(true, "secureinput")
    M.menu:setTitle("🔒")
    M.menu:setTooltip("Secure Input is on: keyboard event taps are blind")
    M.menu:setMenu(menuItems)
  end
  showPill()
end

local function hideMenu()
  if M.menu then M.menu:delete() end
  M.menu = nil
  if M.pill then M.pill:delete() end
  M.pill = nil
end

local function warn(reason)
  lookupHolder(function(latest)
    if not state.on then return end
    -- The registry names the last process to turn it on, which drifts (a
    -- Ghostty password prompt, loginwindow at lock) while the leaker keeps
    -- holding it, so the holder stays the one seen when it turned on.
    state.holder = state.holder or latest
    log("stuck", describe(state.holder) .. " for " .. (os.time() - state.since) .. "s, " .. reason
      .. ", front: " .. frontName() .. ", last enabler: " .. describe(latest))
    toast.show("Held by " .. describe(state.holder) .. ". fn shortcuts are dead. Click to release it.", {
      title = "Secure Input",
      accent = ACCENT,
      timeout = 30,
      onClick = release, -- the card dismisses itself after this
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
    state.session = (state.session or 0) + 1
    state.since, state.holder, state.warned, state.awaySince = os.time(), nil, false, nil
    state.chromeTab, state.announce, state.releasing = nil, false, false
    local session, front = state.session, hs.application.frontmostApplication()
    -- The page that turns it on is the active tab when it happens, so note it
    -- now: by the time it leaks you've moved to another tab or app.
    if front and front:bundleID() == CHROME then
      osascript(CHROME_FRONT_TAB, nil, function(out)
        local wid, tid, url = (out or ""):match("^(%d+) (%d+) (.*)$")
        if not wid or state.session ~= session then return end
        state.chromeTab = { window = wid, tab = tid, url = url }
        log("chrome tab", url)
      end)
    end
    showMenu()
    lookupHolder(function(holder)
      state.holder = holder
      log("on", describe(holder) .. ", front: " .. frontName(front))
    end)
  else
    log("off", "after " .. (os.time() - state.since) .. "s, was " .. describe(state.holder))
    hideMenu()
    if state.warned or state.announce then
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
M.release = release -- hs -c 'secureinput.release()'

return M
