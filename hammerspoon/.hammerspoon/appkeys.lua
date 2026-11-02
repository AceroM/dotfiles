-- Option-key launchers, from a raw keyDown tap.
--
--   alt+shift+a   launch or focus PhotoCraft
--   alt+t         toggle ExcalidrawZ, the offline Excalidraw app
--
-- An event tap sees the key before app hotkeys (Raycast's included), so these
-- win even if another app still claims the same keys.
--
-- Usage from init.lua:
--   appkeys = require("appkeys")
--   appkeys.start()

local M = {}

local EXCALIDRAW_APP = "com.chocoford.excalidraw" -- ExcalidrawZ (brew cask excalidrawz)

function M.photocraft()
  hs.application.launchOrFocus("PhotoCraft")
end

function M.excalidraw()
  local app = hs.application.get(EXCALIDRAW_APP)
  if app and app:isFrontmost() then return app:hide() end
  hs.application.launchOrFocusByBundleID(EXCALIDRAW_APP)
end

function M.start()
  if M.tap then M.tap:stop() end
  local keyA = hs.keycodes.map["a"]
  local keyT = hs.keycodes.map["t"]
  M.tap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(e)
    local code = e:getKeyCode()
    if code ~= keyA and code ~= keyT then return false end
    local flags = e:getFlags()
    local action
    if code == keyT then
      if not flags:containExactly({ "alt" }) then return false end
      action = M.excalidraw
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
