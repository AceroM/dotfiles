-- Keeps every tab label snake_case, as Herdr's were, whoever sets it: an
-- agent, a script, or Rename Tab in the app. "juno16 web :3046" becomes
-- juno16_web_3046 the moment it's set.
--
-- Two kinds of label stay as they are, because something replaces them later
-- and recognizes them by their shape: Rex's generated "Window 1a2b3c4d", and
-- a ticket's "PROD-1234" / "PROD-1234 · slot 1" placeholder. The autoname
-- hook (~/.claude/hooks/rex-autoname.sh) turns both into the chat's topic,
-- already snake_case.
--
-- It also keeps cmd+shift+f's invisible mark (dir-focus.lua). While the sidebar
-- is narrowed to a project, a tab that has the mark keeps it through the
-- rewrite, and a tab with a pane in the project gets it, so a tab opened there
-- shows up in the narrowed sidebar. Once it's off, any mark left is removed.
--
-- Run as a long-lived script that hears every session, including new ones:
--   rex do --all ~/.config/rex/tab-labels.lua

local DF = dofile((os.getenv("HOME") or "") .. "/.config/rex/dir-focus.lua")

local function placeholder(label)
  return label == ""
    or label:match("^Window %x%x%x%x%x%x%x%x$")
    or label:match("^%u+%-%d+$")
    or label:match("^%u+%-%d+ · slot %d+$")
end

local function snake(label)
  return (label:lower():gsub("[^a-z0-9]+", "_"):gsub("^_+", ""):gsub("_+$", ""))
end

-- session.view comes back empty for a session this script hasn't attached,
-- even under --all, so each session is attached once. Only once: an attach
-- changes the session's view, and doing it from the session_view_changed
-- handler would retrigger that handler forever.
local attached = {}

local function view_of(session_id)
  if not attached[session_id] then
    local ok, r = pcall(rex.call, "session.attach", { session_id = session_id })
    if not ok then return nil end
    attached[session_id] = true
    return r and r.view
  end
  local ok, view = pcall(rex.call, "session.view", { session_id = session_id })
  return ok and view or nil
end

local function tidy(session_id)
  local view = view_of(session_id)
  if not view then return end
  local focus = DF.read()
  for _, w in ipairs(view.windows or {}) do
    local label = w.label or ""
    local base = DF.strip(label)
    if not placeholder(base) then
      local s = snake(base)
      if s ~= "" then base = s end
    end
    local mark = focus ~= nil
      and (DF.marked(label) or DF.in_project(session_id, w, focus.root))
    local want = DF.label({ window_id = w.window_id, label = base }, mark)
    if want ~= label then
      rex.call("session.set_window_label", {
        session_id = session_id, window_id = w.window_id, label = want,
      })
    end
  end
end

-- A rename fires window_label_changed; a tab created with a label only
-- changes the session's view.
rex.on("window_label_changed", function(ctx) tidy(ctx.session_id) end)
rex.on("session_view_changed", function(ctx) tidy(ctx.session_id) end)

-- While the sidebar is narrowed, a pane can land in the project without the
-- view changing: a new tab's shell starts there after the tab was created, or
-- a shell cds in. Both re-check its session.
local function recheck(ctx)
  if DF.read() then tidy(ctx.session_id) end
end
rex.on("terminal.process_changed", recheck)
rex.on("terminal.pwd_changed", recheck)

for _, s in ipairs(rex.call("session.list", {}).sessions or {}) do
  tidy(s.session_id)
end
