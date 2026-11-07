-- Convert vertical wheel/trackpad movement to horizontal movement in place.
-- Keeping the original event preserves precision, natural-scroll direction,
-- and trackpad gesture/momentum phases.
local M = {}
local tap
local properties = hs.eventtap.event.properties
local axes = {
  { properties.scrollWheelEventDeltaAxis1, properties.scrollWheelEventDeltaAxis2 },
  { properties.scrollWheelEventFixedPtDeltaAxis1, properties.scrollWheelEventFixedPtDeltaAxis2 },
  { properties.scrollWheelEventPointDeltaAxis1, properties.scrollWheelEventPointDeltaAxis2 },
}

local function handleScroll(event)
  -- Quartz can recalculate the other delta fields when one is written, so
  -- capture every original value before changing any field.
  local horizontal = {}
  for index, axis in ipairs(axes) do
    horizontal[index] = event:getProperty(axis[1]) + event:getProperty(axis[2])
  end
  for index, axis in ipairs(axes) do
    event:setProperty(axis[2], horizontal[index])
    event:setProperty(axis[1], 0)
  end
  return false
end

function M.start()
  if tap then tap:stop() end
  tap = hs.eventtap.new({ hs.eventtap.event.types.scrollWheel }, handleScroll)
  M.tap = tap
  return M
end

function M.toggle()
  if not tap then M.start() end
  if tap:isEnabled() then
    tap:stop()
    hs.alert.show("Horizontal scroll off", 1)
  else
    tap:start()
    hs.alert.show("Horizontal scroll on", 1)
  end
end

return M
