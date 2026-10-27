-- cmd+shift+1 (Shottr's window-capture key): in Chrome, screenshot just the
-- page content. Finds the AXWebArea (excludes vertical tabs, toolbar, infobars),
-- captures the window by id and crops to it. Saves to the screenshot folder and
-- copies to the clipboard. Every other app, and any AX failure, passes the key
-- through untouched so Shottr handles it as before.
--
-- An event tap sees the key before Shottr's own hotkey, so launch order between
-- the two doesn't matter.
--
-- Usage from init.lua:
--   chromeshot = require("chromeshot")
--   chromeshot.start()

local M = {}

local CHROME = "com.google.Chrome"
local SCREENCAPTURE = "/usr/sbin/screencapture"

local function webAreaFrame(win)
  local ax = hs.axuielement.windowElement(win)
  if not ax then return nil end
  -- Breadth-first and capped: Chrome's full AX tree is huge, but the web area
  -- sits near the top of it.
  local queue, i = { { ax, 0 } }, 1
  local deadline = hs.timer.secondsSinceEpoch() + 1
  while queue[i] and hs.timer.secondsSinceEpoch() < deadline do
    local el, depth = queue[i][1], queue[i][2]
    i = i + 1
    if el:attributeValue("AXRole") == "AXWebArea" then
      return el:attributeValue("AXFrame")
    end
    if depth < 10 then
      for _, child in ipairs(el:attributeValue("AXChildren") or {}) do
        queue[#queue + 1] = { child, depth + 1 }
      end
    end
  end
end

local function outputDir()
  local dir = hs.execute("/usr/bin/defaults read com.apple.screencapture location 2>/dev/null"):gsub("%s+$", "")
  if dir == "" then dir = "~/Desktop" end
  return (dir:gsub("^~", os.getenv("HOME")))
end

local function capture(args, onDone)
  hs.task.new(SCREENCAPTURE, onDone, args):start()
end

-- Capture the window by id (so windows floating over Chrome stay out of the
-- shot), then crop the page rect out of it. Window and AX frames are in points;
-- the capture is in pixels, hence the scale.
local function shootChromePage(win, f)
  local stamp = os.date("%Y-%m-%d at %H.%M.%S")
  local tmp = os.tmpname() .. ".png"
  local path = string.format("%s/Screenshot %s.png", outputDir(), stamp)
  capture({ "-x", "-o", "-l", tostring(win:id()), tmp }, function()
    local img = hs.image.imageFromPath(tmp)
    os.remove(tmp)
    if not img then return hs.alert.show("Screenshot failed") end
    local wf = win:frame()
    local scale = img:size().w / wf.w
    local crop = img:croppedCopy({
      x = (f.x - wf.x) * scale, y = (f.y - wf.y) * scale,
      w = f.w * scale, h = f.h * scale,
    })
    if not crop then return hs.alert.show("Screenshot failed") end
    crop:saveToFile(path)
    hs.pasteboard.writeObjects(crop)
  end)
end

-- Re-send the key past our own tap so Shottr gets it.
local function passThrough()
  M.bypass = true
  hs.eventtap.keyStroke({ "cmd", "shift" }, "1", 0)
  hs.timer.doAfter(0.1, function() M.bypass = false end)
end

local function shoot(win)
  win = win or hs.window.frontmostWindow()
  local app = win and win:application()
  if app and app:bundleID() == CHROME then
    local f = webAreaFrame(win)
    if f and f.w > 0 and f.h > 0 then return shootChromePage(win, f) end
  end
  passThrough()
end

M.shoot = shoot

function M.start()
  local key = hs.keycodes.map["1"]
  M.tap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(e)
    if M.bypass or e:getKeyCode() ~= key then return false end
    if e:getProperty(hs.eventtap.event.properties.keyboardEventAutorepeat) ~= 0 then return false end
    if not e:getFlags():containExactly({ "cmd", "shift" }) then return false end
    local app = hs.application.frontmostApplication()
    if not app or app:bundleID() ~= CHROME then return false end
    hs.timer.doAfter(0, shoot) -- keep the AX walk out of the tap callback
    return true
  end):start()
end

return M
