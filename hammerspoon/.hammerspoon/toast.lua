-- Non-activating on-screen toasts drawn with hs.canvas. Nothing here ever takes
-- focus, so whatever you are typing into keeps it.
--
-- Two placements, each with its own independent stack:
--   "topright" — compact one-line cards, stacked down from the top-right corner
--   "center"   — wider multi-line cards, the stack kept centered on screen
--
--   local toast = require("toast")
--   toast.show("build finished", { title = "nvim", placement = "topright" })
--
-- A toast with an id is redrawn in place by the next one with that id, which
-- makes a promise toast (sonner's toast.promise): show it loading, then settle
-- it. A state draws an icon left of the text: a spinner, a ✓ or a ✕.
--   toast.update("deploy", "Deploying…", { state = "loading" }) -- stays up
--   toast.update("deploy", "Deployed", { state = "success" })   -- 4s
--   toast.update("deploy", "Deploy failed", { state = "error" }) -- 10s
-- Scripts do the same through hammerspoon://toast?id=…&state=… (init.lua).

local M = {}

local FONT = "Berkeley Mono"

M.colors = {
  bg = { red = 0.08, green = 0.08, blue = 0.10, alpha = 0.94 },
  stroke = { white = 1, alpha = 0.08 },
  title = { white = 1, alpha = 0.6 },
  body = { white = 1 },
  close = { white = 1, alpha = 0.5 },
}

-- charRatio: advance width of the (monospaced) font as a fraction of its size.
-- Used to wrap text without round-tripping through the text measuring APIs.
M.placements = {
  topright = {
    width = 440,
    margin = 16,
    gap = 8,
    padX = 14,
    padY = 10,
    titleSize = 11,
    bodySize = 14,
    maxLines = 1,
    timeout = 4,
    charRatio = 0.6,
  },
  center = {
    width = 560,
    margin = 16,
    gap = 10,
    padX = 20,
    padY = 14,
    titleSize = 12,
    bodySize = 16,
    maxLines = 5,
    timeout = 6,
    charRatio = 0.6,
  },
}

-- What a state draws and how long it stays. A loading toast waits for the
-- update that settles it; its timeout only clears one whose script died.
M.states = {
  loading = { timeout = 120 },
  success = { color = { red = 0.30, green = 0.80, blue = 0.46 }, timeout = 4 },
  error = { color = { red = 0.95, green = 0.36, blue = 0.33 }, timeout = 10 },
}
local ICON = 16 -- the state icon's square
local ICON_GAP = 10 -- between the icon and the text

-- Active toasts per placement, oldest first, and the ones with an id by id.
local stacks = { topright = {}, center = {} }
local byId = {}

-- --- utf8-safe string helpers ----------------------------------------------
-- Byte-indexed sub/len would split multi-byte glyphs mid-sequence, which shows
-- up as tofu in the canvas.

local function ulen(s)
  return (utf8 and utf8.len(s)) or #s
end

local function usub(s, i, j)
  if not utf8 then
    return s:sub(i, j)
  end
  local from = utf8.offset(s, i)
  if not from then
    return ""
  end
  local to = utf8.offset(s, j + 1)
  return s:sub(from, to and to - 1 or #s)
end

-- Wrap `text` to `cols` columns, at most `maxLines` lines. Overflow is trimmed
-- and marked with an ellipsis so it is obvious something was cut.
local function wrap(text, cols, maxLines)
  if cols < 8 then
    cols = 8
  end
  local lines = {}
  local truncated = false

  local function push(line)
    if #lines >= maxLines then
      truncated = true
      return false
    end
    table.insert(lines, line)
    return true
  end

  for paragraph in (text .. "\n"):gmatch("([^\n]*)\n") do
    local current = ""
    for word in paragraph:gmatch("%S+") do
      -- A single word longer than the line gets hard-broken.
      while ulen(word) > cols do
        if current ~= "" then
          if not push(current) then
            goto done
          end
          current = ""
        end
        if not push(usub(word, 1, cols)) then
          goto done
        end
        word = usub(word, cols + 1, ulen(word))
      end
      local candidate = current == "" and word or (current .. " " .. word)
      if ulen(candidate) <= cols then
        current = candidate
      else
        if not push(current) then
          goto done
        end
        current = word
      end
    end
    if current ~= "" and not push(current) then
      goto done
    end
  end
  ::done::

  if truncated and #lines > 0 then
    local last = lines[#lines]
    if ulen(last) >= cols then
      last = usub(last, 1, cols - 1)
    end
    lines[#lines] = last .. "…"
  end
  if #lines == 0 then
    lines = { "" }
  end
  return lines
end

-- --- layout ----------------------------------------------------------------

local function relayout(name)
  local cfg = M.placements[name]
  local stack = stacks[name]
  local screen = hs.screen.mainScreen():frame()

  local x
  local y
  if name == "center" then
    local total = 0
    for i, t in ipairs(stack) do
      total = total + t.height + (i > 1 and cfg.gap or 0)
    end
    x = screen.x + math.floor((screen.w - cfg.width) / 2)
    y = screen.y + math.max(cfg.margin, math.floor((screen.h - total) / 2))
  else
    x = screen.x + screen.w - cfg.width - cfg.margin
    y = screen.y + cfg.margin
  end

  for _, t in ipairs(stack) do
    t.canvas:topLeft({ x = x, y = y })
    y = y + t.height + cfg.gap
  end
end

local function stopTimers(toast)
  if toast.timer then
    toast.timer:stop()
    toast.timer = nil
  end
  if toast.spin then
    toast.spin:stop()
    toast.spin = nil
  end
end

local function removeToast(name, toast)
  local stack = stacks[name]
  for i, t in ipairs(stack) do
    if t == toast then
      table.remove(stack, i)
      break
    end
  end
  stopTimers(toast)
  toast.removed = true
  if toast.id and byId[toast.id] == toast then
    byId[toast.id] = nil
  end
  local canvas = toast.canvas
  canvas:hide(0.2)
  hs.timer.doAfter(0.25, function()
    canvas:delete()
  end)
  relayout(name)
end

local function arm(toast)
  local state = M.states[toast.opts.state]
  local timeout = toast.opts.timeout or (state and state.timeout) or M.placements[toast.placement].timeout
  toast.timer = hs.timer.doAfter(timeout, function()
    removeToast(toast.placement, toast)
  end)
end

-- The state icon, centred at (cx, cy): a spinning arc on a faint ring while
-- loading, else a filled circle with a ✓ or ✕ stroked on it.
local function drawIcon(toast, canvas, cx, cy)
  local state = toast.opts.state
  local r = ICON / 2
  local center = { x = cx, y = cy }
  if state == "loading" then
    canvas:appendElements({
      type = "circle",
      action = "stroke",
      center = center,
      radius = r - 1.5,
      strokeColor = { white = 1, alpha = 0.15 },
      strokeWidth = 2,
    }, {
      type = "arc",
      action = "stroke",
      center = center,
      radius = r - 1.5,
      startAngle = 0,
      endAngle = 100,
      arcRadii = false,
      strokeColor = { white = 1, alpha = 0.9 },
      strokeWidth = 2,
      strokeCapStyle = "round",
    })
    local arc = canvas:elementCount()
    local angle = 0
    toast.spin = hs.timer.doEvery(1 / 30, function()
      angle = (angle + 12) % 360
      canvas:elementAttribute(arc, "startAngle", angle)
      canvas:elementAttribute(arc, "endAngle", angle + 100)
    end)
    return
  end

  canvas:appendElements({
    type = "circle",
    action = "fill",
    center = center,
    radius = r,
    fillColor = M.states[state].color,
  })
  -- Glyph strokes as offsets from the centre, in the card's background colour.
  local function stroke(points)
    local coords = {}
    for _, p in ipairs(points) do
      coords[#coords + 1] = { x = cx + p[1], y = cy + p[2] }
    end
    canvas:appendElements({
      type = "segments",
      action = "stroke",
      closed = false,
      coordinates = coords,
      strokeColor = M.colors.bg,
      strokeWidth = 2,
      strokeCapStyle = "round",
      strokeJoinStyle = "round",
    })
  end
  if state == "success" then
    stroke({ { -3.6, 0.2 }, { -1.1, 2.8 }, { 3.8, -2.7 } })
  else
    stroke({ { -2.8, -2.8 }, { 2.8, 2.8 } })
    stroke({ { -2.8, 2.8 }, { 2.8, -2.8 } })
  end
end

-- Draw a toast's text and opts onto a new canvas, off screen until the caller
-- places and shows it. Sets toast.canvas and toast.height.
local function render(toast)
  local opts = toast.opts
  local cfg = M.placements[toast.placement]
  local state = M.states[opts.state] and opts.state or nil

  local accentInset = opts.accent and 10 or 0
  local iconX = cfg.padX + accentInset
  local textX = iconX + (state and (ICON + ICON_GAP) or 0)
  local bodyW = cfg.width - textX - cfg.padX

  local cols = math.floor(bodyW / (cfg.bodySize * cfg.charRatio))
  local lines = wrap(tostring(toast.text), cols, opts.maxLines or cfg.maxLines)

  local titleH = cfg.titleSize + 7
  local lineH = math.ceil(cfg.bodySize * 1.4)
  local height = cfg.padY + titleH + (#lines * lineH) + cfg.padY

  local screen = hs.screen.mainScreen():frame()
  -- Created off in the corner; relayout() immediately moves it into place.
  local canvas = hs.canvas.new(hs.geometry.rect(
    screen.x + screen.w - cfg.width - cfg.margin,
    screen.y + cfg.margin,
    cfg.width,
    height
  ))
  canvas:level(hs.canvas.windowLevels.overlay)
  canvas:behavior({ "canJoinAllSpaces", "stationary", "transient" })
  canvas:clickActivating(false)

  canvas:appendElements({
    type = "rectangle",
    action = "fill",
    fillColor = M.colors.bg,
    strokeColor = M.colors.stroke,
    strokeWidth = 1,
    roundedRectRadii = { xRadius = 10, yRadius = 10 },
  })

  if opts.accent then
    canvas:appendElements({
      type = "rectangle",
      action = "fill",
      fillColor = opts.accent,
      frame = { x = 7, y = cfg.padY, w = 3, h = height - 2 * cfg.padY },
      roundedRectRadii = { xRadius = 1.5, yRadius = 1.5 },
    })
  end

  canvas:appendElements({
    type = "text",
    text = opts.title or "Claude Code",
    textColor = M.colors.title,
    textFont = FONT,
    textSize = cfg.titleSize,
    frame = { x = textX, y = cfg.padY, w = bodyW - 22, h = titleH },
  }, {
    type = "text",
    text = table.concat(lines, "\n"),
    textColor = M.colors.body,
    textFont = FONT,
    textSize = cfg.bodySize,
    frame = { x = textX, y = cfg.padY + titleH, w = bodyW, h = #lines * lineH },
  }, {
    type = "text",
    text = "✕",
    textColor = M.colors.close,
    textFont = FONT,
    textSize = cfg.titleSize + 3,
    textAlignment = "center",
    frame = { x = cfg.width - cfg.padX - 16, y = cfg.padY - 1, w = 16, h = titleH },
  })

  toast.canvas = canvas
  toast.height = height
  if state then
    drawIcon(toast, canvas, iconX + ICON / 2, height / 2)
  end

  -- Click to dismiss early, without stealing focus.
  canvas:canvasMouseEvents(true, false, false, false)
  canvas:mouseCallback(function()
    if toast.opts.onClick then
      toast.opts.onClick(toast)
    end
    removeToast(toast.placement, toast)
  end)
end

--- toast.show(text, opts) -> toast
--- opts.title      header line (default "Claude Code")
--- opts.placement  "topright" (default) or "center"
--- opts.timeout    seconds before auto-dismiss (default per state, then placement)
--- opts.accent     hs color table; draws an accent bar down the left edge
--- opts.onClick    called instead of dismissing when the card is clicked
--- opts.id         a later toast with the same id redraws this one in place
--- opts.state      "loading", "success" or "error": an icon left of the text
--- opts.maxLines   body lines before the text is cut (default per placement)
function M.show(text, opts)
  opts = opts or {}
  if opts.id and byId[opts.id] then
    return M.update(opts.id, text, opts)
  end
  local name = M.placements[opts.placement] and opts.placement or "topright"
  local cfg = M.placements[name]
  local toast = { text = text, opts = opts, placement = name, id = opts.id }
  render(toast)

  -- Drop the oldest cards if the stack would run off the screen.
  local stack = stacks[name]
  local screen = hs.screen.mainScreen():frame()
  local available = screen.h - 2 * cfg.margin
  local function stackHeight(extra)
    local total = extra
    for _, t in ipairs(stack) do
      total = total + t.height + cfg.gap
    end
    return total
  end
  while #stack > 0 and stackHeight(toast.height) > available do
    removeToast(name, stack[1])
  end

  table.insert(stack, toast)
  if toast.id then
    byId[toast.id] = toast
  end
  relayout(name)
  toast.canvas:show(0.15)
  arm(toast)
  return toast
end

--- toast.update(id, text, opts) -> toast
--- Redraws the toast with this id in place (a new one if it's gone), keeping
--- the opts this update leaves out, except the timeout, which restarts.
function M.update(id, text, opts)
  opts = opts or {}
  local toast = byId[id]
  if not toast or toast.removed then
    opts.id = id
    return M.show(text, opts)
  end
  for k, v in pairs(toast.opts) do
    if opts[k] == nil and k ~= "timeout" then
      opts[k] = v
    end
  end
  stopTimers(toast)
  local old = toast.canvas
  toast.text, toast.opts = text, opts
  render(toast)
  relayout(toast.placement)
  toast.canvas:show()
  old:delete()
  arm(toast)
  return toast
end

--- Dismiss every visible toast, or only those in one placement.
function M.dismissAll(placement)
  for name, stack in pairs(stacks) do
    if not placement or name == placement then
      for i = #stack, 1, -1 do
        removeToast(name, stack[i])
      end
    end
  end
end

return M
