require("hs.ipc") -- enables the `hs` CLI (hs -c "...") and config reloads

toast = require("toast")
notifications = require("notifications")

-- Toast Slack notifications straight from the notification database, Focus or
-- not (needs Full Disk Access; see notifications.lua). Also feeds `sn`.
notifications.start()

-- Generic toast entry point for scripts:
--   open -g "hammerspoon://toast?title=nvim&msg=done&placement=center&timeout=5"
hs.urlevent.bind("toast", function(_, params)
  toast.show(params.msg or "", {
    title = params.title,
    placement = params.placement,
    timeout = tonumber(params.timeout),
  })
end)

-- Kept for ~/.claude/hooks/toast.sh.
hs.urlevent.bind("claudedone", function(_, params)
  toast.show(params.msg or "Claude finished", {
    title = params.title,
    timeout = tonumber(params.timeout),
  })
end)

-- DJI mic button (and the hotkey) toggle Wispr Flow hands-free dictation into
-- the frontmost app. The old coordinator capture box is shelved; see wispr.lua.
wispr = require("wispr")
wispr.start({ hotkey = { { "ctrl", "alt", "cmd" }, "h" } })

hs.alert.show("Hammerspoon loaded")
