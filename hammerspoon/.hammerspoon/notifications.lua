-- Toast every notification macOS records for the apps in M.rules — even when
-- a Focus mode swallows the banner (this Mac usually runs one, so the old
-- approach of mirroring banners via the accessibility tree had nothing to
-- mirror; see git history for that version).
--
-- macOS writes every delivered notification into the usernoted database.
-- notifdb.py (same directory) reads rows newer than a watermark and prints
-- them as JSON lines; this module toasts them and appends them to M.feed,
-- which other tools consume (`sn`, the Slack inbox TUI).
--
-- Requires Full Disk Access — the notification database is TCC-protected:
--
--   System Settings -> Privacy & Security -> Full Disk Access -> Hammerspoon
--
-- Muting (raycast/Code/extensions/toggle-notification-toasts.sh drives this):
--
--   hs -c "notifications.toggleMuted()"     -- returns the new state
--
-- Muting only silences the toasts. Polling and M.feed keep going, so `sn` still
-- has everything that arrived while the cards were off.
--
-- Debugging:
--
--   hs -c "notifications.debug = true"      -- log each poll to the console
--   hs -c "notifications.rewind(3600)"      -- replay the last hour
--   hs -c "notifications.test()"            -- fake card, no db involved

local toast = require("toast")

local M = {}

M.debug = false

-- bundle id -> how to render it
M.rules = {
  ["com.tinyspeck.slackmacgap"] = {
    name = "Slack",
    placement = "center",
    timeout = 7,
    accent = { red = 0.29, green = 0.68, blue = 0.55, alpha = 1 },
  },
}

M.pollInterval = 2
M.feed = os.getenv("HOME") .. "/.local/state/slack-notifications.jsonl"
M.lastError = nil

local APPLE_EPOCH = 978307200 -- 2001-01-01 in unix seconds
local SETTINGS_KEY = "notifications.watermark"
local MUTE_KEY = "notifications.muted"
local DB = os.getenv("HOME") .. "/Library/Group Containers/group.com.apple.usernoted/db2/db"
local SCRIPT = hs.configdir .. "/notifdb.py"
local PYTHON = "/usr/bin/python3"

local timer = nil
local task = nil
local watermark = 0

-- --- toast + feed ------------------------------------------------------------

local function showToast(row, rule)
  local header = rule.name
  local context = row.subtitle ~= "" and row.subtitle or row.title
  if context and context ~= "" then
    header = rule.name .. " · " .. context
  end
  toast.show(row.body ~= "" and row.body or row.title, {
    title = header,
    placement = rule.placement,
    timeout = rule.timeout,
    accent = rule.accent,
  })
end

local function appendFeed(line)
  local f = io.open(M.feed, "a")
  if not f then
    return
  end
  f:write(line .. "\n")
  f:close()
end

-- --- polling -----------------------------------------------------------------

local function handleOutput(exitCode, stdOut, stdErr)
  task = nil
  if exitCode ~= 0 then
    M.lastError = stdErr or "unknown"
    print("notifications: notifdb.py failed: " .. M.lastError)
    return
  end
  for line in tostring(stdOut):gmatch("[^\n]+") do
    local ok, row = pcall(hs.json.decode, line)
    if ok and type(row) == "table" then
      if row.sentinel then
        if row.sentinel > watermark then
          watermark = row.sentinel
          hs.settings.set(SETTINGS_KEY, watermark)
        end
      else
        if M.debug then
          print(string.format("notifications: %s · %s · %s", row.bundle, row.subtitle, row.body))
        end
        local rule = M.rules[row.bundle]
        if rule then
          if not M.muted() then
            showToast(row, rule)
          end
          appendFeed(line)
        end
      end
    end
  end
end

local function poll()
  if task then
    return -- previous read still running
  end
  local bundles = {}
  for bundle in pairs(M.rules) do
    table.insert(bundles, bundle)
  end
  task = hs.task.new(PYTHON, handleOutput, {
    SCRIPT,
    "--since", string.format("%.6f", watermark),
    "--bundles", table.concat(bundles, ","),
  })
  if not task:start() then
    task = nil
    M.lastError = "failed to start " .. PYTHON
  end
end

-- --- lifecycle ---------------------------------------------------------------

--- Can we actually read the database? (stat succeeds without FDA; read doesn't)
local function dbReadable()
  local f = io.open(DB, "rb")
  if not f then
    return false
  end
  local bytes = f:read(4)
  f:close()
  return bytes ~= nil
end

function M.start()
  if not dbReadable() then
    print("notifications: cannot read the notification database — grant Hammerspoon "
      .. "Full Disk Access (System Settings -> Privacy & Security), then hs.reload()")
    return false
  end

  local now = os.time() - APPLE_EPOCH
  watermark = hs.settings.get(SETTINGS_KEY) or now
  -- Don't replay a long-offline backlog as a toast storm; 10 minutes is plenty.
  watermark = math.max(watermark, now - 600)

  hs.fs.mkdir(os.getenv("HOME") .. "/.local/state")
  -- Keep the feed from growing without bound.
  local size = (hs.fs.attributes(M.feed) or {}).size or 0
  if size > 400 * 1024 then
    hs.execute(string.format([[tail -n 400 "%s" > "%s.tmp" && mv "%s.tmp" "%s"]],
      M.feed, M.feed, M.feed, M.feed))
  end

  if timer then
    timer:stop()
  end
  timer = hs.timer.doEvery(M.pollInterval, poll)
  poll()
  return true
end

function M.stop()
  if timer then
    timer:stop()
    timer = nil
  end
  if task then
    task:terminate()
    task = nil
  end
end

-- --- muting ------------------------------------------------------------------
-- Persisted in hs.settings, so it survives hs.reload() and restarts. Nothing
-- here touches the poll timer or the feed: a muted session still records every
-- notification, it just doesn't draw the cards.

--- Are the toasts currently silenced?
function M.muted()
  return hs.settings.get(MUTE_KEY) == true
end

--- Silence (or un-silence) the toasts. Returns the state it settled on.
function M.setMuted(muted)
  muted = muted and true or false
  hs.settings.set(MUTE_KEY, muted)
  if muted then
    -- Clear the cards already on screen; nobody mutes to keep looking at them.
    for _, rule in pairs(M.rules) do
      toast.dismissAll(rule.placement or "topright")
    end
  end
  return muted
end

--- Flip the mute. Returns the new state — this is what the raycast script reads.
function M.toggleMuted()
  return M.setMuted(not M.muted())
end

--- Move the watermark back and re-poll: replays recent notifications through
--- the toasts and the feed. The feed dedupes downstream by `iden`.
function M.rewind(seconds)
  watermark = watermark - (seconds or 300)
  hs.settings.set(SETTINGS_KEY, watermark)
  poll()
end

--- Fire a fake Slack card to check the design without waiting for a DM.
function M.test()
  local rule = M.rules["com.tinyspeck.slackmacgap"]
  showToast({
    title = "Numeral HQ",
    subtitle = "Miguel Acero",
    body = "hey can you take a look at the staging deploy when you get a sec? "
      .. "the migration step is timing out again",
  }, rule)
end

return M
