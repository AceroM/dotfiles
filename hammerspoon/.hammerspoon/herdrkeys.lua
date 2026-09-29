-- fn+a / fn+s toggle Herdr's quick agent / space pickers from any app.
--
-- hs.hotkey can't bind fn, so this is a raw keyDown tap that checks the fn flag
-- itself. open.sh does the toggling (a second press closes the popup, the other
-- key swaps it); Ghostty is brought forward so the popup is actually visible.
--
-- Usage from init.lua:
--   herdrkeys = require("herdrkeys")
--   herdrkeys.start()

local M = {}

local OPEN = os.getenv("HOME") .. "/.config/herdr/plugins/quick-pickers/open.sh"

local modes = {
  [hs.keycodes.map.a] = "agents",
  [hs.keycodes.map.s] = "spaces",
}

local tap

local function toggle(mode)
  -- `open -b` rather than hs.application, which stack-overflows on this build.
  hs.task.new("/usr/bin/open", nil, { "-b", "com.mitchellh.ghostty" }):start()
  hs.task.new("/bin/sh", nil, { OPEN, mode }):start()
end

local function handleKey(event)
  local mode = modes[event:getKeyCode()]
  if not mode then return false end
  local flags = event:getFlags()
  if not flags.fn or flags.cmd or flags.alt or flags.ctrl or flags.shift then return false end
  if event:getProperty(hs.eventtap.event.properties.keyboardEventAutorepeat) ~= 0 then return true end
  toggle(mode)
  return true
end

function M.start()
  if tap then tap:stop() end
  tap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, handleKey)
  tap:start()
  return M
end

M.toggle = toggle

return M
