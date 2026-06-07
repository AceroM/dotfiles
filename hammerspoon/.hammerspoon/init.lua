local function topRightToast(text, opts)
  opts = opts or {}
  local screen = hs.screen.mainScreen():frame()
  local w, h = 320, 64
  local margin = 16
  local frame = hs.geometry.rect(
    screen.x + screen.w - w - margin,
    screen.y + margin,
    w,
    h
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
    frame = { x = 14, y = 10, w = w - 28, h = 16 },
  }
  canvas[3] = {
    type = "text",
    text = text,
    textColor = { white = 1 },
    textFont = "Berkeley Mono",
    textSize = 14,
    frame = { x = 14, y = 28, w = w - 28, h = h - 36 },
  }

  canvas:show(0.15)
  hs.timer.doAfter(opts.timeout or 4, function()
    canvas:hide(0.25)
    hs.timer.doAfter(0.3, function() canvas:delete() end)
  end)
end

hs.urlevent.bind("claudedone", function(_, params)
  topRightToast(params.msg or "Claude finished", {
    title = params.title,
    timeout = tonumber(params.timeout),
  })
end)

hs.alert.show("Hammerspoon loaded")
