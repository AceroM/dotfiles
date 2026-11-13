-- The fn layer: the herdr keyboard (herdr/.config/herdr/config.toml), moved to Rex.
--
-- The ctrl+alt chords are what a Hammerspoon fn layer sends while Rex is in front,
-- so fn+h/l walk tabs, fn+j/k sessions, and so on, exactly as in herdr. They sit
-- beside init.lua's cmd keys (cmd+h/l, cmd+j/k, cmd+n, cmd+o, ...), which this file
-- leaves alone, and reach for init.lua's actions where it has the better one.
--
-- herdr space -> Rex session, herdr tab -> Rex window (tab), herdr pane -> Rex block.

local bind = rex.bind
local letters = "abcdefghijklmnopqrstuvwxyz"

-- Tabs: ctrl+alt+h/l walk them, 1..8 jump to one, 9 is the last (the browser rule
-- fn+9 had through Hammerspoon), e opens one after the current tab (cmd+n's
-- new_tab_here) and shift+e one before it.
bind("ctrl+alt+n", "client.tab.new")
bind("ctrl+alt+e", "new_tab_here")
bind("ctrl+alt+shift+e", "tab_new_beside", { side = "left" })
bind("ctrl+alt+x", "client.tab.close")
bind("ctrl+alt+h", "client.tab.previous")
bind("ctrl+alt+l", "client.tab.next")
bind("ctrl+alt+r", "client.tab.rename")
bind("ctrl+alt+t", "pane.go_to") -- fn+t: herdr's every-tab picker
for i = 1, 8 do
  bind("ctrl+alt+[Digit" .. i .. "]", "client.tab.goto", { index = i })
end
bind("ctrl+alt+[Digit9]", "client.tab.goto", { index = -1 })

-- Sessions: ctrl+alt+j/k walk the sidebar, u/g jump to its ends, cmd+alt+shift
-- with a digit or a letter jumps by position or by initial.
bind("ctrl+alt+j", "session.next")
bind("ctrl+alt+k", "session.previous")
bind("ctrl+alt+u", "session_goto", { index = 1 })
bind("ctrl+alt+g", "session_goto", { index = -1 })
bind("ctrl+alt+s", "session.switch") -- fn+s: herdr's spaces picker
bind("ctrl+alt+shift+w", "session.switch")
bind("ctrl+alt+shift+r", "session.rename")
bind("ctrl+alt+shift+n", "session_new_below")
for i = 1, 8 do
  bind("cmd+alt+shift+[Digit" .. i .. "]", "session_goto", { index = i })
end
bind("cmd+alt+shift+[Digit9]", "session_goto", { index = -1 })
for letter in letters:gmatch(".") do
  bind("cmd+alt+shift+" .. letter, "session_letter", { letter = letter })
end

-- Agents: shift on the session axis walks agents, and ctrl+alt+o/i go back to the
-- pane I was in before (cmd+o's last_pane). ctrl+alt+a, the next agent waiting on
-- me, and ctrl+alt+;, a new tab running this pane's agent, are init.lua's.
bind("ctrl+alt+shift+j", "agent_next")
bind("ctrl+alt+shift+k", "agent_next", { direction = "previous" })
bind("ctrl+alt+shift+[Digit9]", "agent_goto", { index = -1 })
bind("ctrl+alt+shift+a", "remember_then", { action = "session.switch" }) -- was View Activity, now cmd+p
bind("ctrl+alt+o", "last_pane")
bind("ctrl+alt+i", "last_pane")

-- Panes. option+←/→ stay the shell's word movement; Rex's own cmd+option+arrows
-- move focus too.
bind("ctrl+alt+left", "pane.focus.left")
bind("ctrl+alt+right", "pane.focus.right")
bind("ctrl+alt+up", "pane.focus.up")
bind("ctrl+alt+down", "pane.focus.down")
bind("ctrl+alt+v", "pane.split.right")
bind("ctrl+alt+-", "pane.split.down")
bind("ctrl+alt+w", "pane.close")
bind("ctrl+alt+z", "pane.zoom")
bind("ctrl+alt+y", "pane.copy_id")
bind("ctrl+alt+/", "client.find.open") -- fn+/: herdr's grep picker
bind("ctrl+alt+shift+d", "diff_popup")

-- Hosts (herdr's machines) and chrome.
bind("ctrl+alt+shift+left", "client.host.switch")
bind("ctrl+alt+shift+right", "client.host.switch")
bind("ctrl+alt+b", "client.sidebar.toggle")

-- ctrl+alt+shift+arrows belong to hosts, so resizing is a mode: ctrl+alt+=, then
-- arrows (shift for bigger steps), = to balance, Escape or Return to leave.
rex.mode("resize", { exclusive = true })
bind("ctrl+alt+=", "client.mode.enter", { name = "resize" })
for _, direction in ipairs({ "left", "right", "up", "down" }) do
  bind("resize/" .. direction, "pane.resize", { direction = direction })
  bind("resize/shift+" .. direction, "pane.resize", { direction = direction, amount = 15 })
end
bind("resize/=", "pane.balance")
bind("resize/enter", "client.mode.exit")
