-- Stacking top-right toasts. Each toast is a non-activating hs.canvas, so your
-- terminal never loses focus. Multiple toasts stack vertically (newest at the
-- bottom); when one expires the ones below it slide up to close the gap.
require("hs.ipc") -- enables the `hs` CLI (hs -c "...") and config reloads

local TOAST_W = 440
local TOAST_H = 64
local MARGIN = 16
local GAP = 8

local toasts = {} -- active toasts, top (oldest) -> bottom (newest)

-- Reposition every live toast top-down from the screen's top-right corner.
local function relayout()
  local screen = hs.screen.mainScreen():frame()
  local x = screen.x + screen.w - TOAST_W - MARGIN
  local y = screen.y + MARGIN
  for _, t in ipairs(toasts) do
    t.canvas:topLeft({ x = x, y = y })
    y = y + TOAST_H + GAP
  end
end

local function removeToast(toast)
  for i, t in ipairs(toasts) do
    if t == toast then
      table.remove(toasts, i)
      break
    end
  end
  if toast.timer then
    toast.timer:stop()
  end
  toast.canvas:hide(0.2)
  hs.timer.doAfter(0.25, function() toast.canvas:delete() end)
  relayout()
end

local function topRightToast(text, opts)
  opts = opts or {}
  local screen = hs.screen.mainScreen():frame()
  -- Created at the top slot; relayout() moves it to its real position below.
  local frame = hs.geometry.rect(
    screen.x + screen.w - TOAST_W - MARGIN,
    screen.y + MARGIN,
    TOAST_W,
    TOAST_H
  )

  local canvas = hs.canvas.new(frame)
  canvas:level(hs.canvas.windowLevels.overlay)
  canvas:behavior({ "canJoinAllSpaces", "stationary", "transient" })
  canvas:clickActivating(false)

  canvas[1] = {
    type = "rectangle",
    action = "fill",
    fillColor = { red = 0.08, green = 0.08, blue = 0.10, alpha = 0.94 },
    strokeColor = { white = 1, alpha = 0.08 },
    strokeWidth = 1,
    roundedRectRadii = { xRadius = 10, yRadius = 10 },
  }
  canvas[2] = {
    type = "text",
    text = opts.title or "Claude Code",
    textColor = { white = 1, alpha = 0.6 },
    textFont = "Berkeley Mono",
    textSize = 11,
    frame = { x = 14, y = 10, w = TOAST_W - 28 - 22, h = 16 },
  }
  canvas[3] = {
    type = "text",
    text = text,
    textColor = { white = 1 },
    textFont = "Berkeley Mono",
    textSize = 14,
    frame = { x = 14, y = 28, w = TOAST_W - 28, h = TOAST_H - 36 },
  }
  canvas[4] = {
    type = "text",
    text = "✕",
    textColor = { white = 1, alpha = 0.5 },
    textFont = "Berkeley Mono",
    textSize = 14,
    textAlignment = "center",
    frame = { x = TOAST_W - 30, y = 9, w = 20, h = 18 },
  }

  local toast = { canvas = canvas }

  -- Click a toast to dismiss it early (without stealing focus).
  canvas:canvasMouseEvents(true, false, false, false)
  canvas:mouseCallback(function() removeToast(toast) end)

  -- Drop the oldest if the stack would run off the bottom of the screen.
  local maxVisible = math.max(1, math.floor((screen.h - 2 * MARGIN) / (TOAST_H + GAP)))
  while #toasts >= maxVisible do
    removeToast(toasts[1])
  end

  table.insert(toasts, toast)
  relayout()
  canvas:show(0.15)

  toast.timer = hs.timer.doAfter(opts.timeout or 1.5, function()
    removeToast(toast)
  end)

  return toast
end

hs.urlevent.bind("claudedone", function(_, params)
  topRightToast(params.msg or "Claude finished", {
    title = params.title,
    timeout = tonumber(params.timeout),
  })
end)

hs.alert.show("Hammerspoon loaded")
