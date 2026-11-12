-- Click a file location in Rex to open it in Neovim.
--
--   cmd-click   a centered floating Neovim over the tab (reused while it's open)
--   ctrl-click  the Neovim already in the tab, else that floating Neovim
--
-- Rex can't bind mouse clicks or hook the links it opens, so this is a mouse
-- tap (no keys). Each Rex terminal pane is an AXTextArea ("Terminal") that
-- answers AXRangeForPosition, which gives the line under the pointer and the
-- column clicked. The path-like token there, plus the pane's label from its
-- header, goes to `rex-open` (cli/.local/bin/rex-open), which finds the pane,
-- resolves the path from its directory and opens it.
--
-- Taken: ~/x, ./x, ../x, /abs, a/b/c, name.ext, .dotfile, Makefile and kin,
-- with :line:col, #L12, (12,5) or `", line 12` after them, @path, file:// URLs,
-- and paths the terminal wrapped onto the next line. Anything else, web URLs
-- included, reaches Rex as usual (cmd-click still opens links in the browser).
--
--   rexlinks.hit({ x = 400, y = 300 })  -- what a click there would open
--   rexlinks.start() / rexlinks.stop()

local toast = require("toast")

local M = {}

local REX = "com.superlogical.rex"
local OPEN = os.getenv("HOME") .. "/.local/bin/rex-open"
local types = hs.eventtap.event.types

-- Characters a location can hold. Not ( ) ` , quotes, = or spaces, which wrap
-- paths in prose and output; [ ] stay for Next.js routes like pages/[id]/x.tsx.
local PATH_CHAR = "[%w_%.%-~/@+:#%%%[%]$]"

local BARE_NAMES = {
  Makefile = true, Dockerfile = true, Gemfile = true, Rakefile = true, Procfile = true,
  Justfile = true, justfile = true, Brewfile = true, Vagrantfile = true, Caddyfile = true,
  LICENSE = true, README = true, CHANGELOG = true, Containerfile = true,
}

local function inside(frame, pos)
  return frame and pos.x >= frame.x and pos.x < frame.x + frame.w and pos.y >= frame.y and pos.y < frame.y + frame.h
end

-- The terminal pane under `pos`. Hit-testing (systemElementAtPosition) only
-- finds the transparent group Rex lays over its panes, so this walks the
-- window's panes and takes the last one whose frame holds the point: later
-- in the tree is further in front, so a floating pane beats the tiled one
-- beneath it. About 40 ms for a tab of four panes.
local function terminalAt(pos)
  local app = hs.application.get(REX)
  if not app then return nil end
  local found
  local function walk(el, depth)
    if depth > 14 then return end
    if el:attributeValue("AXRole") == "AXTextArea" then
      if el:attributeValue("AXDescription") == "Terminal" and inside(el:attributeValue("AXFrame"), pos) then
        found = el
      end
      return
    end
    for _, child in ipairs(el:attributeValue("AXChildren") or {}) do walk(child, depth + 1) end
  end
  for _, window in ipairs(hs.axuielement.applicationElement(app):attributeValue("AXWindows") or {}) do
    if inside(window:attributeValue("AXFrame"), pos) then
      walk(window, 1)
      return found -- windows come front to back; the first one holding the point is the one clicked
    end
  end
end

-- AX ranges count UTF-16 units; Lua strings are bytes. The byte offset in
-- `text` of the character `units` UTF-16 units in.
local function byteOffset(text, units)
  local seen = 0
  local ok, offset = pcall(function()
    for position, code in utf8.codes(text) do
      if seen >= units then return position end
      seen = seen + (code > 0xFFFF and 2 or 1)
    end
    return #text + 1
  end)
  return ok and offset or units + 1
end

local function unitLength(text)
  local ok, n = pcall(function()
    local units = 0
    for _, code in utf8.codes(text) do units = units + (code > 0xFFFF and 2 or 1) end
    return units
  end)
  return ok and n or #text
end

-- The run of PATH_CHARs around byte `at`, and where it starts and ends.
local function runAt(text, at)
  if at < 1 or at > #text or not text:sub(at, at):match(PATH_CHAR) then return nil end
  local first, last = at, at
  while first > 1 and text:sub(first - 1, first - 1):match(PATH_CHAR) do first = first - 1 end
  while last < #text and text:sub(last + 1, last + 1):match(PATH_CHAR) do last = last + 1 end
  return text:sub(first, last), first, last
end

local function clean(token)
  token = token:gsub("^[:#]+", ""):gsub("[.:#,]+$", "")
  -- A bracket with no partner is the prose's, not the path's.
  if token:sub(1, 1) == "[" and not token:find("]", 2, true) then token = token:sub(2) end
  if token:sub(-1) == "]" and not token:find("[", 1, true) then token = token:sub(1, -2) end
  return token
end

local function looksLikeLocation(token)
  if not token or not token:match("%w") then return false end
  local scheme = token:match("^(%a[%w+.-]*)://")
  if scheme then return scheme == "file" end -- https:// and friends stay Rex's
  local path = token:gsub("^@", ""):gsub(":%d.*$", ""):gsub("#L%d.*$", "")
  return path:find("/", 1, true) ~= nil -- ~/x, ./x, /abs, a/b
    or path:match("^~$") ~= nil
    or path:match("^[%w_.%-+@]*%.%a[%w]*$") ~= nil -- README.md, .zshrc, foo.test.ts
    or BARE_NAMES[path] == true
end

-- Whether the terminal filled this line to its right edge, so a token at its
-- end may carry on at the start of the next line.
local function fullWidth(terminal, lineRange, text)
  local units = unitLength(text)
  if units == 0 then return false end
  local last = terminal:parameterizedAttributeValue("AXBoundsForRange",
    { location = lineRange.location + units - 1, length = 1 })
  local frame = terminal:attributeValue("AXFrame")
  if not last or not frame or last.w <= 0 then return false end
  return (frame.x + frame.w) - (last.x + last.w) < last.w * 2 + 12
end

local function lineAt(terminal, lineNumber)
  local range = lineNumber and lineNumber >= 0 and terminal:parameterizedAttributeValue("AXRangeForLine", lineNumber)
  local text = range and terminal:parameterizedAttributeValue("AXStringForRange", range)
  if type(text) ~= "string" then return nil end
  return (text:gsub("[\r\n]+$", "")), range
end

-- What a click at `pos` would open: { token, alternates, line, label }, or nil.
-- `terminal` skips the hit test, for trying it while another app covers Rex.
function M.hit(pos, terminal)
  terminal = terminal or terminalAt(pos)
  if not terminal then return nil end
  local index = terminal:parameterizedAttributeValue("AXRangeForPosition", pos)
  if not index then return nil end
  local lineNumber = terminal:parameterizedAttributeValue("AXLineForIndex", index.location)
  local text, range = lineAt(terminal, lineNumber)
  if not text then return nil end
  local run, first, last = runAt(text, byteOffset(text, index.location - range.location))
  if not run then return nil end

  -- A path wrapped onto the next line, by the terminal or by a program that
  -- indents its continuation lines (Claude Code): glue on the next line's head
  -- or the previous line's tail. Both readings go to rex-open, the glued one
  -- first when the line ran to the right edge, and it takes whichever exists.
  local joined, wrapped = run, false
  if last == #text then
    local nextText = lineAt(terminal, lineNumber + 1)
    local head = nextText and nextText:match("^%s*(" .. PATH_CHAR .. "+)")
    if head then
      joined = joined .. head
      wrapped = fullWidth(terminal, range, text)
    end
  end
  local before = text:sub(1, first - 1)
  if before:match("^%s*$") and lineNumber > 0 then
    local prevText, prevRange = lineAt(terminal, lineNumber - 1)
    local tail = prevText and prevText:match("(" .. PATH_CHAR .. "+)$")
    if tail then
      joined = tail .. joined
      wrapped = wrapped or fullWidth(terminal, prevRange, prevText)
    end
  end

  local readings = { clean(run) }
  if joined ~= run then table.insert(readings, wrapped and 1 or 2, clean(joined)) end
  local token, alternates = readings[1], { readings[2] }
  if not looksLikeLocation(token) and not (alternates[1] and looksLikeLocation(alternates[1])) then
    return nil
  end
  local pane = terminal:attributeValue("AXParent")
  return {
    token = token,
    alternates = alternates,
    line = text,
    label = pane and pane:attributeValue("AXDescription") or "",
  }
end

local function open(hit, float)
  local args = { "--label", hit.label, "--line-text", hit.line }
  if float then table.insert(args, "--float") end
  for _, alternate in ipairs(hit.alternates) do
    table.insert(args, "--or")
    table.insert(args, alternate)
  end
  table.insert(args, "--")
  table.insert(args, hit.token)
  local task = hs.task.new(OPEN, function(code, out, err)
    if code ~= 0 then
      local message = (err ~= "" and err or out):gsub("%s+$", "")
      toast.show(message ~= "" and message or ("rex-open exited " .. code), { title = "Rex link" })
    end
  end, args)
  task:setEnvironment({
    HOME = os.getenv("HOME"),
    USER = os.getenv("USER"),
    TMPDIR = os.getenv("TMPDIR"),
    PATH = os.getenv("HOME") .. "/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  })
  task:start()
end

local swallowUp = false

function M.start()
  if M.tap then M.tap:stop() end
  M.tap = hs.eventtap.new({ types.leftMouseDown, types.leftMouseUp }, function(event)
    if event:getType() == types.leftMouseUp then
      if swallowUp then
        swallowUp = false
        return true
      end
      return false
    end
    local flags = event:getFlags()
    if flags.alt or flags.shift or (flags.cmd and flags.ctrl) then return false end
    if not (flags.cmd or flags.ctrl) then return false end
    local app = hs.application.frontmostApplication()
    if not app or app:bundleID() ~= REX then return false end
    local ok, hit = pcall(M.hit, event:location())
    if not ok or not hit then
      print("rexlinks: left to Rex: " .. (ok and "no file location under the pointer" or tostring(hit)))
      return false
    end
    print(string.format("rexlinks: %s %s (pane %q)", flags.cmd and "float" or "tab", hit.token, hit.label))
    swallowUp = true
    open(hit, flags.cmd == true)
    return true
  end)
  M.tap:start()
end

function M.stop()
  if M.tap then M.tap:stop() end
  M.tap = nil
end

return M
