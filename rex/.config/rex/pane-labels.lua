-- Labels each terminal pane with "<directory>  <title>", so the pane header
-- shows the path first, like the tab content item does.
-- Run as a long-lived script: rex do ~/.config/rex/pane-labels.lua

local TERMINAL = "com.superlogical.terminal"
local HOME = os.getenv("HOME") or ""
local paths, titles = {}, {}

-- file:// URL -> plain path, with ~ for the home directory.
local function decode(url)
  if not url or url == "" then return nil end
  local path = url:gsub("^file://[^/]*", "")
  path = path:gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end)
  if HOME ~= "" and path:sub(1, #HOME) == HOME then
    path = "~" .. path:sub(#HOME + 1)
  end
  return path
end

-- The directory a pane is in, asked from Rex when no event has told us yet:
-- its foreground program's, else its shell's, else the last one it reported.
local function pane_dir(block_id)
  local p = rex.block.call(TERMINAL, "process", { block_id = block_id })
  if p then
    if p.foreground and p.foreground.cwd then return decode(p.foreground.cwd) end
    for _, a in ipairs(p.ancestors or {}) do
      if a.cwd then return decode(a.cwd) end
    end
  end
  local r = rex.block.call(TERMINAL, "pwd", { block_id = block_id })
  if r and r.pwd and r.pwd ~= "" then return decode(r.pwd) end
  return nil
end

local function refresh(ctx)
  local bid = ctx.block_id
  if not bid then return end
  paths[bid] = pane_dir(bid) or paths[bid]
  local p, t = paths[bid], titles[bid]
  local label
  if p and t and t ~= "" and t ~= p then
    label = p .. "  " .. t
  else
    label = p or t
  end
  if label and label ~= "" then
    rex.session.set_block_label{ block_id = bid, label = label }
  end
end

rex.on("terminal.pwd_changed", function(ctx, ev)
  paths[ctx.block_id] = decode(ev.pwd)
  refresh(ctx)
end)

rex.on("terminal.title_changed", function(ctx, ev)
  titles[ctx.block_id] = ev.title
  refresh(ctx)
end)
