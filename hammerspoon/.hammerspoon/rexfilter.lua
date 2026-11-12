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

local M = { timers = {} }
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

-- The sidebar, or nil while there's none on screen: it's hidden (View >
-- Toggle Sidebar), or tabs are in the horizontal layout.
local function sidebarOf(win)
  return find(win, function(e)
    return e:attributeValue("AXRole") == "AXGroup" and e:attributeValue("AXDescription") == SIDEBAR
  end, 3)
end

local function filterField(win)
  local sidebar = sidebarOf(win)
  return sidebar and find(sidebar, function(e)
    return e:attributeValue("AXRole") == "AXTextField"
  end, 5)
end

function M.set(q)
  q = q or ""
  local app = hs.application.get(BUNDLE)
  local win = app and (app:focusedWindow() or app:mainWindow())
  if not win then return end
  local back = ax.applicationElement(app):attributeValue("AXFocusedUIElement")
  local axwin = ax.windowElement(win)

  -- Run fn after delay seconds. M.timers holds each pending timer so it isn't
  -- garbage collected before it fires.
  local function after(delay, fn)
    local t
    t = hs.timer.doAfter(delay, function()
      M.timers[t] = nil
      fn()
    end)
    M.timers[t] = true
  end

  -- What the last call did, for: hs -c 'return hs.inspect(rexfilter.last)'
  local last = { q = q, at = os.date("%H:%M:%S"), front = app:isFrontmost(), steps = {} }
  M.last = last
  local function note(s) table.insert(last.steps, s) end

  -- The box is folded away until something focuses it, and it's rebuilt as it
  -- unfolds, so it's looked up again at each step rather than held. A value
  -- written before the focus has settled shows in accessibility but never
  -- reaches the filter, hence the waits.
  --
  -- A folded box in a visible sidebar is empty. With no sidebar on screen
  -- (hidden, or the horizontal tab layout) the box may still hold a value, so
  -- a clear tries to open it too, unless the last value written was empty.
  local hidden = sidebarOf(axwin) == nil
  local folded = filterField(axwin) == nil
  if folded then
    if q == "" and (not hidden or M.applied == "") then note("nothing to clear") return end
    note("unfold: " .. tostring(app:selectMenuItem({ "View", "Focus Tab Filter" })))
  end
  after(folded and 0.35 or 0, function()
    local field = filterField(axwin)
    if not field then note("no box") return end
    field:setAttributeValue("AXFocused", true)
    after(0.15, function()
      field = filterField(axwin)
      if not field then note("box gone") return end
      if not field:attributeValue("AXFocused") then
        note("refocus")
        field:setAttributeValue("AXFocused", true)
      end
      field:setAttributeValue("AXValue", q)
      M.applied = q
      note("written")
      after(0.1, function()
        if back and back:isValid() and back:attributeValue("AXRole") ~= "AXTextField" then
          back:setAttributeValue("AXFocused", true)
        end
      end)
    end)
  end)
end

hs.urlevent.bind("rex-filter", function(_, params)
  M.set(params.q)
end)

return M
