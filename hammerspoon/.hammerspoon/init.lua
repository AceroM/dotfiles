require("hs.ipc") -- enables the `hs` CLI (hs -c "...") and config reloads

toast = require("toast")
notifications = require("notifications")

-- Mirror native banners (Slack, per notifications.rules) as centered cards.
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

hs.alert.show("Hammerspoon loaded")
