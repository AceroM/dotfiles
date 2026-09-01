-- Voice prompts to the herdr coordinator via Wispr Flow.
--
-- Trigger it with the hotkey or the DJI mic button: a small capture box
-- (hs.chooser) grabs keyboard focus and Wispr Flow hands-free dictation
-- starts, so whatever you say lands in the box instead of your frontmost app.
-- Trigger again to stop talking — once the transcript settles it is sent as
-- `herdr agent prompt` to the coordinator. ⏎ sends immediately, Esc cancels.
--
-- The coordinator is resolved at send time: the live agent named
-- "coordinator" if there is one, otherwise the agent whose cwd is exactly
-- ~/Numeral (the orchestrator session; worktree slots like tax-holiday.3
-- deliberately don't match).
--
--   wispr = require("wispr")
--   wispr.start({ hotkey = { { "ctrl", "alt", "cmd" }, "h" } })

local toast = require("toast")

local M = {}

local HERDR = os.getenv("HOME") .. "/.local/bin/herdr"
local COORDINATOR_CWD = os.getenv("HOME") .. "/Numeral"

-- Wispr Flow commits the final transcript asynchronously after hands-free
-- stops, so we wait until the box has been unchanged this long before sending.
M.flushStable = 1.0
M.flushTimeout = 8 -- give up waiting for the flush after this many seconds

local chooser
local state = "idle" -- idle | listening (dictating) | flushing (waiting on Wispr)
local viaButton = false -- current session was started by the mic button
local flushTimer

local function dictation(on)
  -- -g keeps Wispr Flow from activating and stealing focus from the chooser.
  hs.execute(string.format('open -g "wispr-flow://%s-hands-free"', on and "start" or "stop"))
end

local function stopFlushTimer()
  if flushTimer then
    flushTimer:stop()
    flushTimer = nil
  end
end

local function fail(msg)
  toast.show(msg, { title = "wispr → coordinator" })
end

-- Find the coordinator and fire the prompt at it. Public so the wiring can be
-- exercised from a terminal: /opt/homebrew/bin/hs -c 'wispr.send("hello")'
function M.send(text)
  hs.task.new(HERDR, function(code, stdout, stderr)
    if code ~= 0 then
      return fail(stderr ~= "" and stderr or "herdr agent list failed")
    end
    local ok, resp = pcall(hs.json.decode, stdout)
    local agents = ok and resp and resp.result and resp.result.agents
    if not agents then
      return fail("could not parse herdr agent list")
    end
    local target
    for _, a in ipairs(agents) do
      if a.name == "coordinator" then
        target = a
        break
      end
      if not target and a.cwd == COORDINATOR_CWD then
        target = a
      end
    end
    if not target then
      return fail("no coordinator agent (none named coordinator or in ~/Numeral)")
    end
    hs.task.new(HERDR, function(pcode, _, pstderr)
      if pcode == 0 then
        toast.show(text, { title = "→ coordinator", placement = "center" })
      else
        fail(pstderr ~= "" and pstderr or "agent prompt failed")
      end
    end, { "agent", "prompt", target.pane_id, text }):start()
  end, { "agent", "list" }):start()
end

local function finishFlush()
  stopFlushTimer()
  local text = chooser:query() or ""
  state = "idle" -- before hide(), so a callback fired by hiding no-ops
  chooser:hide()
  if text ~= "" then
    M.send(text)
  else
    fail("nothing heard")
  end
end

local function beginFlushWait()
  local last = chooser:query() or ""
  local stableSince = hs.timer.secondsSinceEpoch()
  local deadline = stableSince + M.flushTimeout
  flushTimer = hs.timer.doEvery(0.25, function()
    local q = chooser:query() or ""
    local now = hs.timer.secondsSinceEpoch()
    if q ~= last then
      last, stableSince = q, now
    end
    if (q ~= "" and now - stableSince >= M.flushStable) or now >= deadline then
      finishFlush()
    end
  end)
end

local function makeChooser()
  local c = hs.chooser.new(function(choice)
    -- ⏎ arrives with the mirrored choice; Esc / click-away with nil. Either
    -- way dictation must not be left running.
    if state == "idle" then return end
    stopFlushTimer()
    dictation(false)
    state = "idle"
    if choice and choice.text and choice.text ~= "" then
      M.send(choice.text)
    end
  end)
  c:placeholderText("🎙 talk to the coordinator…")
  c:rows(1)
  c:width(35)
  -- Mirror the query as the single choice so ⏎ submits it.
  c:queryChangedCallback(function(q)
    if q == "" then
      c:choices({})
    else
      c:choices({ { text = q, subText = "⏎ send to coordinator" } })
    end
  end)
  return c
end

function M.toggle()
  if state == "idle" then
    chooser = chooser or makeChooser()
    chooser:query("")
    chooser:choices({})
    chooser:show()
    dictation(true)
    state = "listening"
  elseif state == "listening" then
    dictation(false)
    state = "flushing"
    beginFlushWait()
  else -- flushing; impatient extra press sends whatever is there right now
    finishFlush()
  end
end

-- Abandon the current session without sending anything.
function M.cancel()
  if state == "idle" then return end
  stopFlushTimer()
  dictation(false)
  state = "idle"
  if chooser then chooser:hide() end
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
  -- longer stop dictation — bail out. Hotkey-started sessions are unaffected.
  -- NOTE: hs.audiodevice.watcher is a process-wide singleton; nothing else in
  -- this config uses it.
  hs.audiodevice.watcher.setCallback(function()
    if state ~= "idle" and viaButton and not micIsDefaultInput() then
      M.cancel()
    end
  end)
  hs.audiodevice.watcher.start()
end

function M.start(opts)
  opts = opts or {}
  local key = opts.hotkey or { { "ctrl", "alt", "cmd" }, "h" }
  hs.hotkey.bind(key[1], key[2], function()
    if state == "idle" then viaButton = false end
    M.toggle()
  end)
  startButton()
  return M
end

return M
