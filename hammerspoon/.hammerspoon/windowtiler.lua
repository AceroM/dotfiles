-- fn shortcuts for window tiling (replaces the Raycast / yabai center scripts).
-- Only uses fn keys herdrkeys.lua leaves alone, so the two taps never fight.
--
--   fn+,          left half of the current screen
--   fn+.          right half of the current screen
--   fn+shift+,    left half on the previous screen
--   fn+shift+.    right half on the next screen
--   fn+g          center, keeping the current size
--   fn+f          apply this app's saved size, then center (one move)
--   fn+shift+f    save the focused window's size as this app's preset
--
-- Presets are per app (bundle id) and per screen, keyed by the screen's usable
-- size, so a laptop and an external display can remember different dimensions.
-- They live in ~/.config/windowtiler/presets.json (machine-specific, not in the
-- repo):
--   { "com.mitchellh.ghostty": { "2560x1410": { "w": 1728, "h": 1085 } },
--     "*":                     { "2560x1410": { "w": 1950, "h": 1280 } } }
-- The "*" app is the fallback for apps without a preset of their own.
--
-- Usage from init.lua:
--   windowtiler = require("windowtiler")
--   windowtiler.start()

local M = {}

local keys = hs.keycodes.map
local DIR = os.getenv("HOME") .. "/.config/windowtiler"
local STORE = DIR .. "/presets.json"

local tap

local function load()
  return hs.json.read(STORE) or {}
end

local function save(presets)
  hs.fs.mkdir(DIR)
  hs.json.write(presets, STORE, true, true)
end

local function screenKey(screen)
  local frame = screen:frame()
  return string.format("%dx%d", frame.w, frame.h)
end

local function appId(win)
  local app = win:application()
  return app and (app:bundleID() or app:name())
end

local function place(win, frame)
  win:setFrame(hs.geometry.rect(math.floor(frame.x), math.floor(frame.y), math.floor(frame.w), math.floor(frame.h)), 0)
end

local function centered(size, screen)
  local area = screen:frame()
  local w, h = math.min(size.w, area.w), math.min(size.h, area.h)
  return { x = area.x + (area.w - w) / 2, y = area.y + (area.h - h) / 2, w = w, h = h }
end

local function center(win)
  local frame = win:frame()
  place(win, centered(frame, win:screen()))
end

local function half(win, side, screen)
  local area = screen:frame()
  place(win, {
    x = area.x + (side == "right" and area.w / 2 or 0),
    y = area.y,
    w = area.w / 2,
    h = area.h,
  })
end

local function applyPreset(win)
  local screen = win:screen()
  local presets, key = load(), screenKey(screen)
  local id = appId(win)
  local size = (presets[id] and presets[id][key]) or (presets["*"] and presets["*"][key])
  if not size then
    hs.alert.show("No preset for " .. (id or "app") .. " on " .. key .. " (fn+shift+f saves one)", 2)
    return
  end
  place(win, centered(size, screen))
end

local function savePreset(win)
  local presets, key, id = load(), screenKey(win:screen()), appId(win)
  local frame = win:frame()
  presets[id] = presets[id] or {}
  presets[id][key] = { w = math.floor(frame.w), h = math.floor(frame.h) }
  save(presets)
  hs.alert.show(string.format("Saved %dx%d for %s", frame.w, frame.h, win:application():name()), 1.5)
end

local function handleKey(event)
  local flags = event:getFlags()
  if not flags.fn or flags.cmd or flags.alt or flags.ctrl then return false end

  local code = event:getKeyCode()
  local shift = flags.shift
  local action
  if code == keys[","] then
    action = function(win) half(win, "left", shift and win:screen():previous() or win:screen()) end
  elseif code == keys["."] then
    action = function(win) half(win, "right", shift and win:screen():next() or win:screen()) end
  elseif code == keys.g and not shift then
    action = center
  elseif code == keys.f then
    action = shift and savePreset or applyPreset
  else
    return false
  end

  if event:getProperty(hs.eventtap.event.properties.keyboardEventAutorepeat) == 0 then
    local win = hs.window.focusedWindow()
    if win and not win:isFullScreen() then action(win) end
  end
  return true
end

function M.start()
  if tap then tap:stop() end
  tap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, handleKey)
  tap:start()
  M.tap = tap
  return M
end

return M
