-- Mirror native macOS notification banners into Hammerspoon toasts.
--
-- macOS exposes no notification API to third-party apps, so this watches the
-- accessibility tree of the process that draws the banners
-- (com.apple.notificationcenterui) and reads the text out of each new one.
-- That requires Hammerspoon to hold Accessibility permission:
--
--   System Settings -> Privacy & Security -> Accessibility -> Hammerspoon
--   or run:  hs -c "require('notifications').requestAccess()"
--
-- Only apps listed in M.rules are mirrored; everything else is ignored.
--
-- If the parsing looks wrong, turn on the tree dump and send yourself a
-- message, then read what it saw:
--
--   hs -c "require('notifications').debug = true"
--   hs -c "hs.console.getConsole()" | tail -60

local toast = require("toast")

local M = {}

-- Dump each banner's full accessibility subtree to the Hammerspoon console.
M.debug = false

-- Close the native banner once it has been mirrored, so you only see one card.
-- Off by default: it is the one part of this that touches Slack's own UI.
M.dismissNative = false

-- app name (as it appears in the banner) -> how to render it
M.rules = {
  Slack = {
    placement = "center",
    timeout = 7,
    accent = { red = 0.29, green = 0.68, blue = 0.55, alpha = 1 },
  },
}

local NC_BUNDLE = "com.apple.notificationcenterui"

local observer = nil
local appWatcher = nil
local retryTimer = nil
local lastKey = nil
local lastAt = 0

-- --- accessibility tree walking --------------------------------------------

local function attr(element, name)
  local ok, value = pcall(function()
    return element:attributeValue(name)
  end)
  if ok then
    return value
  end
end

local function children(element)
  return attr(element, "AXChildren") or {}
end

-- Collect every non-empty AXStaticText value in document order. Banners lay
-- their text out as app name, then title, then body.
local function collectTexts(element, out, depth)
  depth = depth or 0
  if depth > 14 then
    return out
  end
  if attr(element, "AXRole") == "AXStaticText" then
    local value = attr(element, "AXValue") or attr(element, "AXTitle")
    if type(value) == "string" and value:match("%S") then
      table.insert(out, value)
    end
  end
  for _, child in ipairs(children(element)) do
    collectTexts(child, out, depth + 1)
  end
  return out
end

local function dumpTree(element, depth, out)
  depth = depth or 0
  out = out or {}
  if depth > 14 then
    return out
  end
  local parts = {}
  for _, name in ipairs({ "AXRole", "AXSubrole", "AXIdentifier", "AXTitle", "AXValue", "AXDescription" }) do
    local value = attr(element, name)
    if type(value) == "string" and value ~= "" then
      table.insert(parts, name:gsub("^AX", "") .. "=" .. string.format("%q", value))
    end
  end
  table.insert(out, string.rep("  ", depth) .. table.concat(parts, " "))
  for _, child in ipairs(children(element)) do
    dumpTree(child, depth + 1, out)
  end
  return out
end

-- Climb to the enclosing AXWindow: observers fire on inner elements too, and
-- the window is the only node guaranteed to hold the whole banner.
local function enclosingWindow(element)
  local current = element
  for _ = 1, 12 do
    if not current then
      return nil
    end
    if attr(current, "AXRole") == "AXWindow" then
      return current
    end
    current = attr(current, "AXParent")
  end
  return nil
end

local function findCloseButton(element, depth)
  depth = depth or 0
  if depth > 14 then
    return nil
  end
  if attr(element, "AXRole") == "AXButton" then
    local label = (attr(element, "AXTitle") or attr(element, "AXDescription") or ""):lower()
    if label:find("close") or label:find("dismiss") or label:find("clear") then
      return element
    end
  end
  for _, child in ipairs(children(element)) do
    local found = findCloseButton(child, depth + 1)
    if found then
      return found
    end
  end
  return nil
end

-- --- banner handling -------------------------------------------------------

--- Split a banner's static texts into app / title / body.
--- Exposed so it is easy to adjust once you have seen a real dump.
function M.parse(texts)
  local app = texts[1]
  local title = texts[2]
  local rest = {}
  for i = 3, #texts do
    table.insert(rest, texts[i])
  end
  return app, title, table.concat(rest, "  ")
end

local function handle(element)
  local window = enclosingWindow(element) or element
  local texts = collectTexts(window, {})

  if M.debug then
    print("── notification banner ──")
    print(table.concat(dumpTree(window), "\n"))
    print("texts: " .. hs.inspect(texts))
  end

  if #texts == 0 then
    return
  end

  local app, title, body = M.parse(texts)
  local rule = app and M.rules[app]
  if not rule then
    return
  end

  -- The observer fires more than once per banner; collapse repeats.
  local key = table.concat(texts, "\1")
  local now = hs.timer.secondsSinceEpoch()
  if key == lastKey and (now - lastAt) < 3 then
    return
  end
  lastKey, lastAt = key, now

  local header = app
  if title and title ~= "" and title ~= app then
    header = app .. " · " .. title
  end

  toast.show(body ~= "" and body or (title or app), {
    title = header,
    placement = rule.placement,
    timeout = rule.timeout,
    accent = rule.accent,
  })

  if M.dismissNative then
    local button = findCloseButton(window)
    if button then
      pcall(function()
        button:performAction("AXPress")
      end)
    end
  end
end

-- --- observer wiring -------------------------------------------------------

local function attach()
  local app = hs.application.applicationsForBundleID(NC_BUNDLE)[1]
  if not app then
    return false
  end
  local axApp = hs.axuielement.applicationElement(app)
  if not axApp then
    return false
  end

  if observer then
    observer:stop()
    observer = nil
  end

  local new = hs.axuielement.observer.new(app:pid())
  if not new then
    return false
  end

  new:callback(function(_, element)
    -- Attributes of a just-created element are not populated yet; let the
    -- banner finish building before reading it.
    hs.timer.doAfter(0.2, function()
      pcall(handle, element)
    end)
  end)

  local watching = false
  for _, notification in ipairs({ "AXWindowCreated", "AXCreated" }) do
    if pcall(function()
      new:addWatcher(axApp, notification)
    end) then
      watching = true
    end
  end
  if not watching then
    return false
  end

  new:start()
  observer = new
  return true
end

--- Prompt for Accessibility permission (opens System Settings).
function M.requestAccess()
  return hs.accessibilityState(true)
end

function M.start()
  if not hs.accessibilityState() then
    print("notifications: Accessibility is not granted to Hammerspoon — "
      .. "banner mirroring is off. Run: hs -c \"require('notifications').requestAccess()\"")
    return false
  end

  if not appWatcher then
    appWatcher = hs.application.watcher.new(function(_, event, app)
      if app and app:bundleID() == NC_BUNDLE and event == hs.application.watcher.launched then
        hs.timer.doAfter(1, attach)
      end
    end)
    appWatcher:start()
  end

  if attach() then
    return true
  end

  -- NotificationCenter may not be up yet at login; keep trying briefly.
  if retryTimer then
    retryTimer:stop()
  end
  local tries = 0
  retryTimer = hs.timer.doEvery(3, function()
    tries = tries + 1
    if attach() or tries >= 10 then
      retryTimer:stop()
      retryTimer = nil
    end
  end)
  return false
end

function M.stop()
  if observer then
    observer:stop()
    observer = nil
  end
  if appWatcher then
    appWatcher:stop()
    appWatcher = nil
  end
  if retryTimer then
    retryTimer:stop()
    retryTimer = nil
  end
end

--- Fire a fake Slack banner to check the card design without waiting for a DM.
function M.test()
  local rule = M.rules.Slack
  toast.show("hey can you take a look at the staging deploy when you get a sec? "
    .. "the migration step is timing out again", {
    title = "Slack · Miguel Acero",
    placement = rule.placement,
    timeout = rule.timeout,
    accent = rule.accent,
  })
end

return M
