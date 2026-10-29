require("hs.ipc") -- enables the `hs` CLI (hs -c "...") and config reloads

-- Keep the native Hammerspoon menu, with a simpler template icon.
-- Retain the image globally so Lua's collector doesn't remove its cached name.
menuBarIcon = hs.image.imageFromPath(hs.configdir .. "/icons/hammer.svg")
if menuBarIcon then
  menuBarIcon:size({ w = 18, h = 18 }):template(true)
  local previousIcon = hs.image.imageFromName("statusicon")
  if previousIcon then
    previousIcon:name("statusicon-previous-" .. hs.timer.absoluteTime())
  end
  assert(menuBarIcon:name("statusicon"), "Could not replace Hammerspoon menu icon")
  hs.menuIcon(false)
  hs.menuIcon(true)
end

toast = require("toast")
notifications = require("notifications")

-- Toast Slack notifications straight from the notification database, Focus or
-- not (needs Full Disk Access; see notifications.lua). Also feeds `sn`.
notifications.start()

-- Generic toast entry point for scripts:
--   open -g "hammerspoon://toast?title=nvim&msg=done&placement=center&timeout=5"
hs.urlevent.bind("toast", function(_, params)
  toast.show(params.msg or "", {
    title = params.title,
    placement = params.placement,
    timeout = tonumber(params.timeout),
  })
end)

-- Kept for ~/.claude/hooks/toast.sh.
hs.urlevent.bind("claudedone", function(_, params)
  toast.show(params.msg or "Claude finished", {
    title = params.title,
    timeout = tonumber(params.timeout),
  })
end)

-- DJI mic button (and the hotkey) toggle Wispr Flow hands-free dictation into
-- the frontmost app. The old coordinator capture box is shelved; see wispr.lua.
wispr = require("wispr")
wispr.start({ hotkey = { { "ctrl", "alt", "cmd" }, "h" } })

-- fn+a focuses the next agent needing attention; fn+shift+a / fn+s toggle
-- Herdr's quick agent / space pickers; see herdrkeys.lua.
-- fn+m opens the matching spaces picker to move the current tab.
-- fn+q toggles Quick Record from any app through the same Fn-key handler.
-- fn+b toggles vertical wheel/trackpad movement into horizontal scrolling.
herdrkeys = require("herdrkeys")
herdrkeys.start()

-- Window tiling on fn keys herdrkeys leaves free: fn+,/. halves (shift = other
-- screen), fn+g center, fn+f apply app size + center, fn+shift+f save size.
windowtiler = require("windowtiler")
windowtiler.start()

-- Option-A opens the artifacts server in Chrome; Option-Shift-A focuses PhotoCraft.
appkeys = require("appkeys")
appkeys.start()

-- Command-shift-1 screenshots Chrome's page content only; other apps keep Shottr's window capture.
chromeshot = require("chromeshot")
chromeshot.start()

-- Option-minus toggles external displays; Option-plus toggles the laptop.
-- Both use Lunar to switch between 0% and 80%.
-- Run asynchronously so Lunar's DDC calls don't block other global hotkeys.
local brightnessTask
local function toggleBrightness(displayFilter)
  if brightnessTask and brightnessTask:isRunning() then return end
  brightnessTask = hs.task.new("/bin/bash", function(exitCode, stdout, stderr)
    brightnessTask = nil
    if exitCode ~= 0 then
      hs.alert.show("Lunar brightness toggle failed")
      print("Lunar brightness toggle: " .. stdout .. stderr)
    end
  end, { os.getenv("HOME") .. "/Code/extensions/toggle-brightness.sh", displayFilter })
  brightnessTask:start()
end

hs.hotkey.bind({ "alt" }, "-", function()
  toggleBrightness("external")
end)
-- Plus is Shift-equals on the keyboard.
hs.hotkey.bind({ "alt", "shift" }, "=", function()
  toggleBrightness("builtin")
end)

hs.alert.show("Hammerspoon loaded")
