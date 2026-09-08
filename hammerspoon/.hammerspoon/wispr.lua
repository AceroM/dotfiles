-- DJI mic button → Wispr Flow dictation.
--
-- The button on the DJI transmitter toggles Wispr Flow hands-free dictation:
-- press once to start talking, again to stop. The text lands in whatever app
-- is frontmost — Wispr's normal behaviour, just driven from the mic.
--
-- The coordination flow this used to do (a capture box that fed the transcript
-- to `herdr agent prompt` for the coordinator agent) is shelved; it's in git
-- history at 10a5124 if it comes back.
--
--   wispr = require("wispr")
--   wispr.start({ hotkey = { { "ctrl", "alt", "cmd" }, "h" } })

local M = {}

local state = "idle" -- idle | listening
local viaButton = false -- current session was started by the mic button

local function dictation(on)
  -- -g keeps Wispr Flow from activating and stealing focus from whatever
  -- you're dictating into.
  hs.execute(string.format('open -g "wispr-flow://%s-hands-free"', on and "start" or "stop"))
end

-- Wispr has no toggle URL, so the state here is ours, not Wispr's: starting
-- dictation with Wispr's own hotkey and then stopping it with the button (or
-- vice versa) can leave the two out of step for one press.
function M.toggle()
  if state == "idle" then
    dictation(true)
    state = "listening"
  else
    dictation(false)
    state = "idle"
  end
end

function M.stop()
  if state == "idle" then return end
  dictation(false)
  state = "idle"
end

function M.state()
  return state
end

-- DJI mic button --------------------------------------------------------------
-- Lifted from khinshankhan's DjiWispr spoon: the mic button reaches macOS via
-- the USB receiver ("Wireless Mic Rx") as a SOUND_UP media key, which is
-- indistinguishable from the keyboard's volume-up key. So the button is only
-- intercepted while the receiver is the default INPUT device — the rest of the
-- time volume-up behaves normally. (Side effect: while the Rx is the input,
-- the keyboard's volume-up key is a dictation button too.)

M.micMatch = "Wireless Mic Rx"
M.triggerKey = "SOUND_UP"
M.debounce = 0.35 -- seconds to ignore repeat trigger events
M.watchdogInterval = 10 -- macOS sometimes silently disables event taps

local tap, watchdog
local lastFire = 0

local function micIsDefaultInput()
  local dev = hs.audiodevice.defaultInputDevice()
  return dev ~= nil and (dev:name() or ""):find(M.micMatch, 1, true) ~= nil
end

local function handleSystemKey(event)
  local key = event:systemKey()
  if not (key and key.key == M.triggerKey) then return false end
  if not micIsDefaultInput() then return false end

  -- Ours from here on, so swallow the key-up half too.
  if not key.down then return true end

  local now = hs.timer.secondsSinceEpoch()
  if now - lastFire < M.debounce then return true end
  lastFire = now

  if state == "idle" then viaButton = true end
  M.toggle()
  return true
end

local function startButton()
  tap = hs.eventtap.new({ hs.eventtap.event.types.systemDefined }, handleSystemKey)
  tap:start()
  watchdog = hs.timer.doEvery(M.watchdogInterval, function()
    if tap and not tap:isEnabled() then tap:start() end
  end)
  -- If the receiver stops being the input mid-session, the button can no
  -- longer stop dictation — stop it here. Hotkey-started sessions are
  -- unaffected.
  -- NOTE: hs.audiodevice.watcher is a process-wide singleton; nothing else in
  -- this config uses it.
  hs.audiodevice.watcher.setCallback(function()
    if state ~= "idle" and viaButton and not micIsDefaultInput() then
      M.stop()
    end
  end)
  hs.audiodevice.watcher.start()
end

function M.start(opts)
  opts = opts or {}
  local key = opts.hotkey
  if key then
    hs.hotkey.bind(key[1], key[2], function()
      if state == "idle" then viaButton = false end
      M.toggle()
    end)
  end
  startButton()
  return M
end

return M
