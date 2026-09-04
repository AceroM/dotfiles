-- Non-activating on-screen toasts drawn with hs.canvas. Nothing here ever takes
-- focus, so whatever you are typing into keeps it.
--
-- Two placements, each with its own independent stack:
--   "topright" — compact one-line cards, stacked down from the top-right corner
--   "center"   — wider multi-line cards, the stack kept centered on screen
--
--   local toast = require("toast")
--   toast.show("build finished", { title = "nvim", placement = "topright" })

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

-- Active toasts per placement, oldest first.
local stacks = { topright = {}, center = {} }

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

local function removeToast(name, toast)
  local stack = stacks[name]
  for i, t in ipairs(stack) do
    if t == toast then
      table.remove(stack, i)
      break
    end
  end
  if toast.timer then
    toast.timer:stop()
    toast.timer = nil
  end
  toast.canvas:hide(0.2)
  hs.timer.doAfter(0.25, function()
    toast.canvas:delete()
  end)
  relayout(name)
end

--- toast.show(text, opts) -> toast
--- opts.title      header line (default "Claude Code")
--- opts.placement  "topright" (default) or "center"
--- opts.timeout    seconds before auto-dismiss (default per placement)
--- opts.accent     hs color table; draws an accent bar down the left edge
--- opts.onClick    called instead of dismissing when the card is clicked
function M.show(text, opts)
  opts = opts or {}
  local name = M.placements[opts.placement] and opts.placement or "topright"
  local cfg = M.placements[name]

  local accentInset = opts.accent and 10 or 0
  local textX = cfg.padX + accentInset
  local bodyW = cfg.width - textX - cfg.padX

  local cols = math.floor(bodyW / (cfg.bodySize * cfg.charRatio))
  local lines = wrap(tostring(text), cols, cfg.maxLines)

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

  local toast = { canvas = canvas, height = height, placement = name }

  -- Click to dismiss early, without stealing focus.
  canvas:canvasMouseEvents(true, false, false, false)
  canvas:mouseCallback(function()
    if opts.onClick then
      opts.onClick(toast)
    end
    removeToast(name, toast)
  end)

  -- Drop the oldest cards if the stack would run off the screen.
  local stack = stacks[name]
  local available = screen.h - 2 * cfg.margin
  local function stackHeight(extra)
    local total = extra
    for _, t in ipairs(stack) do
      total = total + t.height + cfg.gap
    end
    return total
  end
  while #stack > 0 and stackHeight(height) > available do
    removeToast(name, stack[1])
  end

  table.insert(stack, toast)
  relayout(name)
  canvas:show(0.15)

  toast.timer = hs.timer.doAfter(opts.timeout or cfg.timeout, function()
    removeToast(name, toast)
  end)

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
