-- fn shortcuts for Rex.app, from a raw keyDown tap (hs.hotkey can't bind fn).
-- The name is from Herdr, whose fn layer this was; herdr is uninstalled.
--
-- In Rex.app, fn+key becomes ctrl+alt+key and Rex's ~/.config/rex/keys.lua does
-- the rest:
--   fn+a e h i j k l n o r s t w x y z - ; /   become ctrl+alt+the same key
--   fn+1..8, fn+9      become ctrl+alt+1..9 (tab N, last tab)
--   fn+c, fn+d         become ctrl+alt+b, ctrl+alt+v (sidebar, split)
--   fn+←/→             become ctrl+alt+←/→ (macOS has already turned them into
--                      home/end, so those keycodes are mapped back to arrows)
--   fn+shift+key       adds shift (ctrl+alt+shift+key); fn+shift+1..9 becomes
--                      cmd+alt+shift+1..9 (session N), and fn+shift+d keeps its
--                      letter (the diff popup)
--   fn+option/cmd+j/k/9  become ctrl+alt+shift+j/k/9 (the agent axis)
-- fn+a, fn+e and fn+n act once per press, not on key repeat.
--
-- Quick Record, from any app (Rex included):
--   fn+q               toggle region recording
--   fn+shift+q         the same, with microphone and system audio
--   fn+option+q        toggle a demo (annotations, narration, a HAR from Chrome)
--   fn+option+a        switch the demo between interact and draw
--
-- Outside Rex, the fn chords that used to drive Herdr from any app (fn+a, s, m,
-- t, ;, /, y) do nothing, and stay consumed so macOS's own Globe shortcuts (fn+a
-- focuses the Dock) don't fire in their place. Other fn keys pass through;
-- windowtiler.lua uses some of them.
--
-- Usage from init.lua:
--   herdrkeys = require("herdrkeys")
--   herdrkeys.start()

local M = {}

local HOME = os.getenv("HOME")
local REX = "com.superlogical.rex"

local keys = hs.keycodes.map
local workspaceKeys = {}
for number = 1, 9 do workspaceKeys[keys[tostring(number)]] = true end

-- Rex.app: fn+key becomes ctrl+alt+key for every key below, with a few renames
-- (fn+c -> b, fn+d -> v, fn+home/end -> left/right).
local rexKeys = {}
for _, name in ipairs({ "a", "e", "h", "i", "j", "k", "l", "n", "o", "r", "s", "t", "w", "x", "y", "z", "-", ";", "/" }) do
  rexKeys[keys[name]] = true
end
for number = 1, 9 do rexKeys[keys[tostring(number)]] = true end
rexKeys[keys.c] = keys.b
rexKeys[keys.d] = keys.v
rexKeys[keys.home] = keys.left
rexKeys[keys["end"]] = keys.right
-- Held down, these would open or jump again on every repeat.
local rexOnce = { [keys.a] = true, [keys.e] = true, [keys.n] = true }

-- The chords that used to reach Herdr from any app; swallowed outside Rex.
local formerlyGlobal = {
  [keys.a] = true, [keys.s] = true, [keys.m] = true, [keys.t] = true,
  [keys[";"]] = true, [keys["/"]] = true, [keys.y] = true,
}

local tap
local inflight = {} -- keeps background tasks alive until they answer

local function quickRecord(command)
  local task
  task = hs.task.new("/usr/bin/open", function(exitCode, _, stderr)
    inflight[task] = nil
    if exitCode ~= 0 then
      hs.printf("Quick Record %s failed: %s", command, stderr or "")
      hs.alert.show("Couldn’t open Quick Record. Run its install.sh first.", 3)
    end
  end, { "-g", "-a", HOME .. "/Applications/Quick Record.app", "quickrecord://" .. command })
  if not task then return end
  inflight[task] = true
  if not task:start() then
    inflight[task] = nil
    hs.alert.show("Couldn’t start Quick Record.", 3)
  end
end

local function toggleRecording(withAudio)
  quickRecord(withAudio and "toggle-audio" or "toggle")
end

-- The Quick Record command an fn chord sends, or nil if it isn't one.
local function quickRecordCommand(code, flags)
  if not flags.fn or flags.cmd or flags.ctrl then return nil end
  if flags.alt then
    if flags.shift then return nil end
    if code == keys.q then return "toggle-demo" end
    if code == keys.a then return "annotate" end
    return nil
  end
  if code == keys.q then return flags.shift and "toggle-audio" or "toggle" end
  return nil
end

local function rexFocused()
  local win = hs.window.focusedWindow()
  local app = win and win:application()
  return app ~= nil and app:bundleID() == REX
end

-- Rewrite an fn chord in place for Rex.app's keys.lua; false lets it through.
local function forwardToRex(event, code, flags)
  local target = rexKeys[code]
  if not target then return false end
  if rexOnce[code] and event:getProperty(hs.eventtap.event.properties.keyboardEventAutorepeat) ~= 0 then
    return true
  end
  if flags.alt or flags.cmd then
    -- fn+option or fn+cmd on j/k/9 is the agent axis, like fn+shift+j/k.
    if flags.shift or (flags.alt and flags.cmd)
        or not (code == keys.j or code == keys.k or code == keys["9"]) then
      return false
    end
    event:setFlags({ ctrl = true, alt = true, shift = true })
  elseif flags.shift and workspaceKeys[code] then
    event:setFlags({ cmd = true, alt = true, shift = true }) -- session N
  else
    event:setFlags({ ctrl = true, alt = true, shift = flags.shift or nil })
  end
  -- fn+shift+d keeps its letter: that's the diff popup, not a split.
  if target ~= true and not (flags.shift and code == keys.d) then
    event:setKeyCode(target)
  end
  return false
end

local function handleKey(event)
  local code = event:getKeyCode()
  local flags = event:getFlags()

  local command = quickRecordCommand(code, flags)
  if command then
    if event:getProperty(hs.eventtap.event.properties.keyboardEventAutorepeat) == 0 then
      quickRecord(command)
    end
    return true
  end

  if flags.fn and not flags.ctrl and rexFocused() then
    return forwardToRex(event, code, flags)
  end

  if not flags.fn or flags.cmd or flags.alt or flags.ctrl then return false end
  -- fn+shift reached Herdr only on a and y.
  if flags.shift then return code == keys.a or code == keys.y end
  return formerlyGlobal[code] == true
end

function M.start()
  if tap then tap:stop() end
  tap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, handleKey)
  tap:start()
  return M
end

M.toggleRecording = toggleRecording
M.toggleDemo = function() quickRecord("toggle-demo") end

return M
