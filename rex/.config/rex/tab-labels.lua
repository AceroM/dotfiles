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
-- Run as a long-lived script that hears every session, including new ones:
--   rex do --all ~/.config/rex/tab-labels.lua

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
  for _, w in ipairs(view.windows or {}) do
    local label = w.label or ""
    if not placeholder(label) then
      local want = snake(label)
      if want ~= "" and want ~= label then
        rex.call("session.set_window_label", {
          session_id = session_id, window_id = w.window_id, label = want,
        })
      end
    end
  end
end

-- A rename fires window_label_changed; a tab created with a label only
-- changes the session's view.
rex.on("window_label_changed", function(ctx) tidy(ctx.session_id) end)
rex.on("session_view_changed", function(ctx) tidy(ctx.session_id) end)

for _, s in ipairs(rex.call("session.list", {}).sessions or {}) do
  tidy(s.session_id)
end
