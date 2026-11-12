-- Writes the Filter box at the top of Rex's sidebar (View > Focus Tab Filter),
-- which narrows the sidebar to the tabs whose title or session name contains
-- the text. Rex has no API for that box, so this sets it through
-- accessibility.
--
-- Rex's cmd+shift+f (dir_focus in ~/.config/rex/init.lua) calls it:
--   open -g 'hammerspoon://rex-filter?q=<text>'     an empty q clears it
--
-- The box only takes a value while it has keyboard focus (a value set
-- otherwise shows in accessibility but doesn't filter), so this focuses it,
-- writes, and gives focus back to whatever had it, normally the terminal.

local ax = require("hs.axuielement")

local M = {}
local BUNDLE = "com.superlogical.rex"
local SIDEBAR = "Sidebar Tabs"

-- Breadth-first, so the sidebar is found before the terminal panes' trees.
local function find(root, pred, maxDepth)
  local queue, depths = { root }, { 0 }
  local i = 1
  while queue[i] do
    local e, d = queue[i], depths[i]
    if pred(e) then return e end
    if d < maxDepth then
      for _, c in ipairs(e:attributeValue("AXChildren") or {}) do
        table.insert(queue, c)
        table.insert(depths, d + 1)
      end
    end
    i = i + 1
  end
end

local function filterField(win)
  local sidebar = find(win, function(e)
    return e:attributeValue("AXRole") == "AXGroup" and e:attributeValue("AXDescription") == SIDEBAR
  end, 3)
  return find(sidebar or win, function(e)
    return e:attributeValue("AXRole") == "AXTextField"
  end, sidebar and 5 or 8)
end

function M.set(q)
  q = q or ""
  local app = hs.application.get(BUNDLE)
  local win = app and (app:focusedWindow() or app:mainWindow())
  if not win then return end
  local back = ax.applicationElement(app):attributeValue("AXFocusedUIElement")
  local axwin = ax.windowElement(win)

  local function write(field)
    field:setAttributeValue("AXFocused", true)
    M.timer = hs.timer.doAfter(0.05, function()
      field:setAttributeValue("AXValue", q)
      M.timer = hs.timer.doAfter(0.1, function()
        if back and back:isValid() then back:setAttributeValue("AXFocused", true) end
      end)
    end)
  end

  local field = filterField(axwin)
  if field then return write(field) end
  if q == "" then return end -- no box, so nothing to clear

  -- The box is folded away until something focuses it.
  app:selectMenuItem({ "View", "Focus Tab Filter" })
  local tries = 0
  M.timer = hs.timer.doEvery(0.05, function()
    tries = tries + 1
    local f = filterField(axwin)
    if f or tries >= 20 then
      M.timer:stop()
      if f then write(f) end
    end
  end)
end

hs.urlevent.bind("rex-filter", function(_, params)
  M.set(params.q)
end)

return M
