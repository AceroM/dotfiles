-- The second half of cmd+n (new_tab_here in init.lua). The app makes the new
-- tab only after that action returns, so the action starts this script
-- detached, and it waits for the tab to appear and moves it into place.
--
-- rex.args: session_id, the session the tab goes into; before, the tab it
-- goes in front of (the one after the tab cmd+n was pressed in); known, the
-- session's tabs before the new one was made. The first tab that isn't in
-- known is the new one.
--
-- Try it: rex do -s SESSION ~/.config/rex/new-tab-here.lua \
--   --args '{"session_id":"…","before":"window:…","known":["window:…"]}'
-- then make a tab in SESSION within 3 seconds.

local args = rex.args or {}
local known = {}
for _, id in ipairs(args.known or {}) do known[id] = true end

for _ = 1, 60 do -- 3 seconds
  local view = rex.session.view{ session_id = args.session_id }
  for _, w in ipairs(view and view.windows or {}) do
    if not known[w.window_id] then
      local ok, err = pcall(rex.session.move_window, {
        session_id = args.session_id,
        window_id = w.window_id,
        before_window_id = args.before,
      })
      return { window_id = w.window_id, moved = ok, error = not ok and tostring(err) or nil }
    end
  end
  rex.sleep(0.05)
end
return { moved = false, error = "no new tab appeared" }
