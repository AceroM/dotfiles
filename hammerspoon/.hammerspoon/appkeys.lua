-- Option-key launchers, from a raw keyDown tap.
--
--   alt+t         toggle ExcalidrawZ, the offline Excalidraw app
--
-- Option-A types å again (agent pages moved to `af`), and Option-Shift-A is
-- left to Lid Awake's own hotkey (~/temp/dots/apps/lid-awake).
--
-- An event tap sees the key before app hotkeys (Raycast's included), so these
-- win even if another app still claims the same keys.
--
-- Usage from init.lua:
--   appkeys = require("appkeys")
--   appkeys.start()

local M = {}

local EXCALIDRAW_APP = "com.chocoford.excalidraw" -- ExcalidrawZ (brew cask excalidrawz)

function M.excalidraw()
  local app = hs.application.get(EXCALIDRAW_APP)
  if app and app:isFrontmost() then return app:hide() end
  hs.application.launchOrFocusByBundleID(EXCALIDRAW_APP)
end

function M.start()
  if M.tap then M.tap:stop() end
  local keyT = hs.keycodes.map["t"]
  M.tap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(e)
    if e:getKeyCode() ~= keyT or not e:getFlags():containExactly({ "alt" }) then return false end
    -- Swallow key repeat so holding the keys doesn't type †.
    if e:getProperty(hs.eventtap.event.properties.keyboardEventAutorepeat) == 0 then
      hs.timer.doAfter(0, M.excalidraw)
    end
    return true
  end):start()
  return M
end

return M
