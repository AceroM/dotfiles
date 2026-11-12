-- What cmd+shift+f (dir_focus in init.lua) and tab-labels.lua share: the mark,
-- the state file, and which tabs belong to a project.
--
-- Rex can't hide a single tab. The sidebar's Filter box can, but it matches
-- only tab titles and session names, as one literal substring (no OR, no
-- directories). So while the sidebar is narrowed to a project, every tab with
-- a pane in that project carries MARK at the end of its label, and the filter
-- is set to MARK. MARK is U+2063 INVISIBLE SEPARATOR: the label looks the same,
-- and the filter compares it literally rather than folding it away.

local M = {}

M.TERMINAL = "com.superlogical.terminal"
M.MARK = "\226\129\163" -- U+2063, as UTF-8 bytes
M.STATE = (os.getenv("HOME") or "") .. "/.local/state/rex/dir-focus.json"

function M.strip(label)
  return ((label or ""):gsub(M.MARK, ""))
end

function M.marked(label)
  return (label or ""):find(M.MARK, 1, true) ~= nil
end

-- The label a tab gets with the mark on or off. A tab with no label at all
-- would show only the invisible mark, so it gets Rex's generated name instead.
function M.label(window, on)
  local base = M.strip(window.label)
  if not on then return base end
  if base == "" then base = "Window " .. window.window_id:sub(-8) end
  return base .. M.MARK
end

-- { root = "/path" } while the sidebar is narrowed, else nil.
function M.read()
  local f = io.open(M.STATE, "r")
  if not f then return nil end
  local text = f:read("*a")
  f:close()
  local ok, state = pcall(rex.json.decode, text)
  return ok and type(state) == "table" and state.root and state or nil
end

function M.write(state)
  if not state then os.remove(M.STATE) return end
  rex.exec{ "mkdir", "-p", M.STATE:match("^(.*)/") }
  local f = assert(io.open(M.STATE, "w"))
  f:write(rex.json.encode(state))
  f:close()
end

-- The directory a pane is in: its foreground program's, else its shell's,
-- else the last one it reported with OSC 7. Without session_id the pane is in
-- the session the action runs in; a pane in another session needs its
-- session_id, and that session attached first.
function M.pane_cwd(block_id, session_id)
  if not block_id then return nil end
  local function call(method)
    if not session_id then return rex.block.call(M.TERMINAL, method, { block_id = block_id }) end
    local ok, r = pcall(rex.call, "block.method",
      { session_id = session_id, block_id = block_id, method = method })
    return ok and r or nil
  end
  local p = call("process")
  if p then
    if p.foreground and p.foreground.cwd then return p.foreground.cwd end
    for _, a in ipairs(p.ancestors or {}) do
      if a.cwd then return a.cwd end
    end
  end
  local r = call("pwd")
  if r and r.pwd and r.pwd ~= "" then
    local path = r.pwd:gsub("^file://[^/]*", "")
    return (path:gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end))
  end
  return nil
end

-- The nearest directory at or above dir holding a .git (a directory in a
-- repo, a file in a worktree), else dir itself.
function M.project_root(dir)
  local d = dir
  while d and d:match("^/.") do
    local f = io.open(d .. "/.git", "r")
    if f then f:close() return d end
    d = d:match("^(.*)/[^/]*$")
  end
  return dir
end

function M.inside(path, root)
  return path == root or path:sub(1, #root + 1) == root .. "/"
end

-- Whether any terminal pane of window (a window from a session view) is in root.
function M.in_project(session_id, window, root)
  for _, layer in ipairs(window.layers or {}) do
    for _, b in ipairs(layer.blocks or {}) do
      if b.creator_name == M.TERMINAL then
        local dir = M.pane_cwd(b.block_id, session_id)
        if dir and M.inside(dir, root) then return true end
      end
    end
  end
  return false
end

return M
