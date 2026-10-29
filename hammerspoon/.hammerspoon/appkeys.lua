-- Option-key launchers, from a raw keyDown tap.
--
--   alt+a         toggle the Artifacts app (~/.dotfiles/artifacts/app); without
--                 it installed, focus the Chrome tab showing localhost:4620
--   alt+shift+a   launch or focus PhotoCraft
--
-- An event tap sees the key before app hotkeys (Raycast's included), so these
-- win even if another app still claims the same keys.
--
-- Usage from init.lua:
--   appkeys = require("appkeys")
--   appkeys.start()

local M = {}

local CHROME = "com.google.Chrome"
local ARTIFACTS = "http://localhost:4620"
local ARTIFACTS_APP = "local.artifacts" -- bundle id set by artifacts/app/bundle.sh

-- Looks for the page under either host name, since the CLI prints both.
local FOCUS_ARTIFACTS = [[
tell application "Google Chrome"
  repeat with w in windows
    set i to 0
    repeat with t in tabs of w
      set i to i + 1
      set u to URL of t
      if u starts with "http://localhost:4620" or u starts with "http://127.0.0.1:4620" then
        set active tab index of w to i
        set index of w to 1
        activate
        return true
      end if
    end repeat
  end repeat
  return false
end tell
]]

function M.artifacts()
  local app = hs.application.get(ARTIFACTS_APP)
  if app and app:isFrontmost() then return app:hide() end
  if hs.application.launchOrFocusByBundleID(ARTIFACTS_APP) then return end
  local ok, found = hs.osascript.applescript(FOCUS_ARTIFACTS)
  if ok and found then return end
  -- No tab yet, or no Automation permission for Chrome: open a fresh one.
  hs.urlevent.openURLWithBundle(ARTIFACTS .. "/", CHROME)
end

function M.photocraft()
  hs.application.launchOrFocus("PhotoCraft")
end

function M.start()
  if M.tap then M.tap:stop() end
  local key = hs.keycodes.map["a"]
  M.tap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(e)
    if e:getKeyCode() ~= key then return false end
    local flags = e:getFlags()
    local action
    if flags:containExactly({ "alt" }) then
      action = M.artifacts
    elseif flags:containExactly({ "alt", "shift" }) then
      action = M.photocraft
    else
      return false
    end
    -- Swallow key repeat so holding the keys doesn't type å / Å.
    if e:getProperty(hs.eventtap.event.properties.keyboardEventAutorepeat) == 0 then
      hs.timer.doAfter(0, action) -- keep AppleScript out of the tap callback
    end
    return true
  end):start()
  return M
end

return M
