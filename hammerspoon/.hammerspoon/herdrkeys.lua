-- fn shortcuts for Herdr, from a raw keyDown tap (hs.hotkey can't bind fn).
--
--   fn+a          focus the next agent needing attention (from any app)
--   fn+shift+a    toggle the quick agents picker (from any app)
--   fn+s          toggle the quick spaces picker (from any app)
--   fn+t          toggle the tabs picker (every tab in every space)
--   fn+;          toggle the recent Claude/Codex sessions picker; Enter
--                 resumes one in a new tab with permissions bypassed
--   fn+/          toggle the grep picker: filter every other pane's visible
--                 screen (no scrollback) line by line; Enter focuses that pane
--   fn+y          copy the focused pane's Claude/Codex session id
--   fn+shift+y    copy the focused pane's Herdr pane id
--   fn+q          toggle Quick Record's region recording (from any app)
--   fn+x/w/o/i    become ctrl+alt+x/w/o/i in Ghostty: close tab, close pane,
--                 last pane back/forth
--   fn+h/l        become ctrl+alt+h/l in Ghostty: previous / next tab
--   fn+1..9       become ctrl+alt+1..9 in Ghostty: jump to the Nth tab
--   fn+shift+1..9 become cmd+alt+shift+1..9 in Ghostty: jump to the Nth space
--   fn+j/k        become ctrl+alt+j/k in Ghostty: next / previous space
--   fn+shift+j/k  become ctrl+alt+shift+j/k in Ghostty: next / previous agent
--   fn+d / fn+-   become ctrl+alt+v / ctrl+alt+minus in Ghostty: split
--                 vertically / horizontally
--   fn+z          becomes ctrl+alt+z in Ghostty: zoom the pane
--   fn+c          becomes ctrl+alt+b in Ghostty: toggle the sidebar
--   fn+r          becomes ctrl+alt+r in Ghostty: rename tab
--   fn+shift+r    becomes ctrl+alt+shift+r in Ghostty: rename space
--   fn+n          becomes ctrl+alt+n in Ghostty: new tab
--   fn+e          becomes ctrl+alt+e in Ghostty: new tab next to the current
--   fn+shift+n    becomes ctrl+alt+shift+n in Ghostty: new space
--   fn+arrows     become ctrl+alt+arrows in Ghostty: focus the pane that way.
--                 macOS has already turned fn+arrow into home/end/pgup/pgdn
--                 by the time the tap sees it, so those keycodes are mapped
--                 back to arrows (outside Ghostty they keep their usual job)
--   ctrl+alt+;    (and +shift) handled here too while Ghostty is focused, so
--                 Herdr's own binding -- a slower shell hop -- is only a fallback
--
-- Everything talks to the Herdr socket via nc: every spawned process costs
-- ~20-30ms on this machine, and the pickers used to chain nine of them.
--
-- Usage from init.lua:
--   herdrkeys = require("herdrkeys")
--   herdrkeys.start()

local M = {}

local HOME = os.getenv("HOME")
local socket
local PIDFILE = HOME .. "/.cache/herdr-quick-picker.pid"
local GHOSTTY = "com.mitchellh.ghostty"
local PLUGIN = "miguel.quick-pickers"
local WIDTH = 40 -- ~300px at font-size 14
local SESSIONS_WIDTH = 110 -- title + cwd + age
local SESSIONS_ROWS = 20 -- sessions.ts LIMIT
local GREP_WIDTH = 120 -- long screen lines + location

local keys = hs.keycodes.map
local pickers = { [keys.a] = "agents", [keys.s] = "spaces", [keys.t] = "tabs", [keys[";"]] = "sessions", [keys["/"]] = "grep" }
local remapped = {
  [keys.x] = true, [keys.w] = true, [keys.o] = true, [keys.i] = true,
  [keys.h] = true, [keys.j] = true, [keys.k] = true, [keys.l] = true,
  [keys["-"]] = true, [keys.n] = true, [keys.r] = true, [keys.e] = true,
  [keys.z] = true, -- fn+z -> ctrl+alt+z (zoom)
  [keys.c] = keys.b, -- fn+c -> ctrl+alt+b (toggle sidebar)
  [keys.d] = keys.v, -- fn+d -> ctrl+alt+v
  [keys["1"]] = true, [keys["2"]] = true, [keys["3"]] = true, -- fn+digit ->
  [keys["4"]] = true, [keys["5"]] = true, [keys["6"]] = true, -- ctrl+alt+digit
  [keys["7"]] = true, [keys["8"]] = true, [keys["9"]] = true, -- (switch_tab)
  [keys.home] = keys.left, [keys["end"]] = keys.right,
  [keys.pageup] = keys.up, [keys.pagedown] = keys.down,
}
-- Keys whose shifted chord is handled too: forwarded (fn+shift+n ->
-- ctrl+alt+shift+n), fn+shift+a -> agents picker, or fn+shift+y -> copy the pane id.
local shiftable = {
  [keys.a] = true, [keys.j] = true, [keys.k] = true,
  [keys.n] = true, [keys.r] = true, [keys.y] = true,
}
local workspaceKeys = {}
for number = 1, 9 do
  local code = keys[tostring(number)]
  workspaceKeys[code] = true
  shiftable[code] = true
end

local tap
local inflight = {} -- keeps background tasks alive until they answer

local function socketCandidates()
  local paths, seen = {}, {}
  local function add(path)
    if path and not seen[path] and hs.fs.attributes(path, "mode") == "socket" then
      seen[path] = true
      paths[#paths + 1] = path
    end
  end
  add(socket)
  add(os.getenv("HERDR_SOCKET"))
  local xdg = os.getenv("XDG_CONFIG_HOME")
  if xdg then add(xdg .. "/herdr/herdr.sock") end
  add(HOME .. "/.config/herdr/herdr.sock")
  for name in hs.fs.dir(HOME .. "/.config") do
    if name ~= "." and name ~= ".." then
      add(HOME .. "/.config/" .. name .. "/herdr/herdr.sock")
    end
  end
  return paths
end

local function toggleRecording()
  local task
  task = hs.task.new("/usr/bin/open", function(exitCode, _, stderr)
    inflight[task] = nil
    if exitCode ~= 0 then
      hs.printf("Quick Record toggle failed: %s", stderr or "")
      hs.alert.show("Couldn’t open Quick Record. Run its install.sh first.", 3)
    end
  end, { "-g", "-a", HOME .. "/Applications/Quick Record.app", "quickrecord://toggle" })
  if not task then return end
  inflight[task] = true
  if not task:start() then
    inflight[task] = nil
    hs.alert.show("Couldn’t start Quick Record.", 3)
  end
end

-- One JSON request/response over the Herdr socket. cb(response, rawLine).
-- Via `nc -U`, not hs.socket: hs.socket crashes Hammerspoon outright when it
-- connects to a unix socket (GCDAsyncSocket urlFromSockaddrUN, 1.1.1).
local function request(method, params, cb)
  local line = hs.json.encode({ id = "hs", method = method, params = params or {} })
  -- hs.json encodes an empty table as [], which Herdr rejects.
  line = line:gsub('"params":%[%]', '"params":{}')
  local paths = socketCandidates()
  local function tryPath(index)
    local path = paths[index]
    if not path then
      socket = nil
      if cb then cb({ error = { code = "socket_unavailable" } }, "") end
      return
    end
    local task
    task = hs.task.new("/usr/bin/nc", function(_, stdout)
      inflight[task] = nil
      local raw = (stdout or ""):match("^[^\n]*")
      local ok, response = pcall(hs.json.decode, raw or "")
      if not ok or type(response) ~= "table" or response.id ~= "hs" then
        if socket == path then socket = nil end
        return tryPath(index + 1)
      end
      socket = path
      if cb then cb(response, raw) end
    end, { "-U", "-w", "2", path })
    if not task then return tryPath(index + 1) end
    inflight[task] = true
    task:setInput(line .. "\n")
    if not task:start() then
      inflight[task] = nil
      return tryPath(index + 1)
    end
    task:closeInput()
  end
  tryPath(1)
end

local function ghosttyFocused()
  local win = hs.window.focusedWindow()
  local app = win and win:application()
  return app ~= nil and app:bundleID() == GHOSTTY
end

local function focusNextAgent()
  if not ghosttyFocused() then
    hs.task.new("/usr/bin/open", nil, { "-b", GHOSTTY }):start()
  end
  local task
  task = hs.task.new("/bin/bash", function(exitCode, _, stderr)
    inflight[task] = nil
    if exitCode ~= 0 then
      hs.printf("Herdr agent attention failed: %s", stderr or "")
      hs.alert.show("Couldn’t focus the next agent. See ~/.local/state/herdr-agent-attention.log", 3)
    end
  end, { HOME .. "/.local/bin/herdr-agent-attention" })
  if not task then return end
  inflight[task] = true
  if not task:start() then
    inflight[task] = nil
    hs.alert.show("Couldn’t start Herdr agent attention.", 3)
  end
end

local function openPicker(mode, attempt)
  request("session.snapshot", nil, function(response, raw)
    local snap = response.result and response.result.snapshot
    if not snap then return end
    local area = snap.layouts and snap.layouts[1] and snap.layouts[1].area or { width = 80, height = 24 }
    local lists = { agents = snap.agents, spaces = snap.workspaces, tabs = snap.tabs }
    local count = lists[mode] and #lists[mode] or (mode == "grep" and 1000 or SESSIONS_ROWS)
    local width = mode == "sessions" and SESSIONS_WIDTH or mode == "grep" and GREP_WIDTH or WIDTH
    request("plugin.pane.open", {
      plugin_id = PLUGIN,
      entrypoint = mode,
      placement = "popup",
      focus = true,
      width = math.min(width, area.width),
      -- rows + query/count/blank/footer + border, capped at 80% of the client
      height = math.min(count + 7, math.floor(area.height * 0.8)),
      env = { QP_SNAPSHOT = raw }, -- the picker skips its own fetch
    }, function(opened)
      -- Swapping pickers can race the old popup's teardown.
      local code = opened.error and opened.error.code
      if code == "ui_busy" and (attempt or 0) < 10 then
        hs.timer.doAfter(0.02, function() openPicker(mode, (attempt or 0) + 1) end)
      end
    end)
  end)
end

-- Same key closes the picker, the other key swaps it. The pidfile is only a
-- hint: Herdr SIGKILLs popups, so it can go stale; popup.close is the truth.
local function toggle(mode)
  if not ghosttyFocused() then
    hs.task.new("/usr/bin/open", nil, { "-b", GHOSTTY }):start()
  end
  local file = io.open(PIDFILE, "r")
  local openMode = file and file:read("*l"):match("^%d+ (%a+)")
  if file then file:close() end
  if not openMode then return openPicker(mode) end
  request("popup.close", nil, function(response)
    os.remove(PIDFILE)
    if response.result and openMode == mode then return end
    openPicker(mode)
  end)
end

local function copyAgentSession(agent, session)
  hs.pasteboard.setContents(session)
  hs.alert.show("Copied " .. (agent.agent or "agent") .. " session " .. session:sub(1, 8) .. "…", 1)
end

-- Existing Codex processes can lack Herdr's SessionStart metadata. Resolve
-- their own open transcript instead of guessing from cwd or newest session.
local function copyCodexSession(agent)
  request("pane.process_info", { pane_id = agent.pane_id }, function(response)
    local info = response.result and response.result.process_info
    local pids = {}
    for _, process in ipairs(info and info.foreground_processes or {}) do
      local executable = (process.argv and process.argv[1]) or process.argv0 or ""
      if process.name == "codex" or executable:match("([^/]+)$") == "codex" then
        pids[#pids + 1] = tostring(process.pid)
      end
    end
    if #pids == 0 then
      hs.alert.show("No Codex process found in the focused pane", 2)
      return
    end
    local task
    task = hs.task.new("/usr/sbin/lsof", function(exitCode, stdout)
      inflight[task] = nil
      local sessions = {}
      if exitCode == 0 or exitCode == 1 then
        for line in (stdout or ""):gmatch("[^\r\n]+") do
          local path = line:match("^n(.*/rollout%-[^/]+%.jsonl)$")
          local file = path and io.open(path, "r")
          if file then
            local metadata = file:read("*l")
            file:close()
            local ok, record = pcall(hs.json.decode, metadata or "")
            local session = ok and type(record) == "table" and record.type == "session_meta"
              and type(record.payload) == "table" and record.payload.id
            if type(session) == "string" and session ~= "" then sessions[session] = true end
          end
        end
      end
      local session = next(sessions)
      if session and not next(sessions, session) then
        copyAgentSession(agent, session)
      else
        hs.alert.show("Couldn’t identify one Codex session in the focused pane", 2)
      end
    end, { "-nP", "-a", "-p", table.concat(pids, ","), "-Fn" })
    if not task then
      hs.alert.show("Couldn’t inspect the focused Codex process", 2)
      return
    end
    inflight[task] = true
    if not task:start() then
      inflight[task] = nil
      hs.alert.show("Couldn’t inspect the focused Codex process", 2)
    end
  end)
end

local function copySessionId()
  request("session.snapshot", nil, function(response)
    local snap = response.result and response.result.snapshot
    if not snap then
      hs.alert.show("Couldn’t read the focused Herdr pane", 2)
      return
    end
    for _, agent in ipairs(snap.agents or {}) do
      if agent.pane_id == snap.focused_pane_id then
        local session = agent.agent_session and agent.agent_session.value
        if type(session) == "string" and session ~= "" then
          copyAgentSession(agent, session)
          return
        elseif agent.agent == "codex" then
          copyCodexSession(agent)
          return
        end
      end
    end
    hs.alert.show("No Claude/Codex session in the focused pane", 1)
  end)
end

local function copyPaneId()
  request("session.snapshot", nil, function(response)
    local snap = response.result and response.result.snapshot
    local pane = snap and snap.focused_pane_id
    if not pane then
      hs.alert.show("No focused Herdr pane", 1)
      return
    end
    hs.pasteboard.setContents(pane)
    hs.alert.show("Copied pane " .. pane, 1)
  end)
end

local function handleKey(event)
  local code = event:getKeyCode()
  local flags = event:getFlags()

  if flags.ctrl and flags.alt and not flags.cmd and code == keys[";"] then
    if not ghosttyFocused() then return false end
    toggle(flags.shift and "spaces" or "agents")
    return true
  end

  if not flags.fn or flags.cmd or flags.alt or flags.ctrl then return false end
  if flags.shift and not shiftable[code] then return false end
  local mode = pickers[code]
  if not mode and code ~= keys.y and code ~= keys.q and not remapped[code] then return false end
  local autorepeat = event:getProperty(hs.eventtap.event.properties.keyboardEventAutorepeat) ~= 0

  if code == keys.q then
    if not autorepeat then toggleRecording() end
    return true
  elseif code == keys.a then
    if not autorepeat then
      if flags.shift then toggle("agents") else focusNextAgent() end
    end
    return true
  elseif mode then
    if not autorepeat then toggle(mode) end
    return true
  elseif code == keys.y then
    if not autorepeat then
      if flags.shift then copyPaneId() else copySessionId() end
    end
    return true
  elseif ghosttyFocused() then
    if code == keys.e and autorepeat then return true end
    -- Rewrite in place using Herdr's indexed-space chord for shifted digits.
    if flags.shift and workspaceKeys[code] then
      event:setFlags({ cmd = true, alt = true, shift = true })
    else
      event:setFlags({ ctrl = true, alt = true, shift = flags.shift or nil })
    end
    if remapped[code] ~= true then event:setKeyCode(remapped[code]) end
  end
  return false
end

function M.start()
  if tap then tap:stop() end
  tap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, handleKey)
  tap:start()
  return M
end

M.toggle = toggle
M.focusNextAgent = focusNextAgent
M.copySessionId = copySessionId
M.copyPaneId = copyPaneId
M.toggleRecording = toggleRecording

return M
