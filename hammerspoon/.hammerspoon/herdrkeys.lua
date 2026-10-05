-- fn shortcuts for Herdr, from a raw keyDown tap (hs.hotkey can't bind fn).
--
--   fn+a          focus the next agent needing attention (from any app)
--   fn+shift+a    toggle the quick agents picker (from any app)
--   fn+s          toggle the quick spaces picker (from any app)
--   fn+m          move the current tab to a numbered space (from any app)
--   fn+t          toggle the tabs picker (every tab in every space)
--   fn+;          toggle the recent Claude/Codex sessions picker; Enter
--                 resumes one in a new tab with permissions bypassed
--   fn+/          toggle the grep picker: filter every other pane's visible
--                 screen (no scrollback) line by line; Enter focuses that pane
--   fn+y          copy "Claude/Codex session ID <id>" for the focused pane
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
local socketCheckedAt = 0
local PIDFILE = HOME .. "/.cache/herdr-quick-picker.pid"
local GHOSTTY = "com.mitchellh.ghostty"
local PLUGIN = "miguel.quick-pickers"
local WIDTH = 40 -- ~300px at font-size 14
local SESSIONS_WIDTH = 110 -- title + cwd + age
local SESSIONS_ROWS = 20 -- sessions.ts LIMIT
local GREP_WIDTH = 120 -- long screen lines + location

local keys = hs.keycodes.map
local pickers = { [keys.a] = "agents", [keys.s] = "spaces", [keys.m] = "move", [keys.t] = "tabs", [keys[";"]] = "sessions", [keys["/"]] = "grep" }
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
  add(os.getenv("HERDR_SOCKET_PATH"))
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
local function requestOnSocket(method, params, cb)
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
    -- hs.task never drains a pipe past 64KB (a session.snapshot with many
    -- agents), leaving nc blocked in write forever. Spool through a file.
    local out = os.tmpname()
    local task
    task = hs.task.new("/bin/sh", function()
      inflight[task] = nil
      local file = io.open(out, "r")
      local raw = file and file:read("*l") or ""
      if file then file:close() end
      os.remove(out)
      local ok, response = pcall(hs.json.decode, raw or "")
      if not ok or type(response) ~= "table" or response.id ~= "hs" then
        if socket == path then socket = nil end
        return tryPath(index + 1)
      end
      socket = path
      if cb then cb(response, raw) end
    end, { "-c", 'exec /usr/bin/nc -U -w 2 "$1" > "$2"', "sh", path, out })
    if not task then
      os.remove(out)
      return tryPath(index + 1)
    end
    inflight[task] = true
    task:setInput(line .. "\n")
    if not task:start() then
      inflight[task] = nil
      os.remove(out)
      return tryPath(index + 1)
    end
    task:closeInput()
  end
  tryPath(1)
end

-- Hammerspoon has no shell environment. With multiple live servers the
-- default socket may belong to a background session, so follow Ghostty's
-- Herdr client instead. Cache briefly to keep chained requests inexpensive.
local function request(method, params, cb)
  local app = hs.application.get(GHOSTTY)
  if not app or hs.timer.secondsSinceEpoch() - socketCheckedAt < 2 then
    return requestOnSocket(method, params, cb)
  end
  local task
  task = hs.task.new("/usr/bin/python3", function(exitCode, stdout)
    inflight[task] = nil
    local path = exitCode == 0 and (stdout or ""):match("^([^\r\n]+)")
    if path and hs.fs.attributes(path, "mode") == "socket" then socket = path end
    socketCheckedAt = hs.timer.secondsSinceEpoch()
    requestOnSocket(method, params, cb)
  end, { HOME .. "/.hammerspoon/herdr-socket.py", tostring(app:pid()) })
  if not task then return requestOnSocket(method, params, cb) end
  inflight[task] = true
  if not task:start() then
    inflight[task] = nil
    return requestOnSocket(method, params, cb)
  end
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
    local lists = { agents = snap.agents, spaces = snap.workspaces, move = snap.workspaces, tabs = snap.tabs }
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
  local record = file and file:read("*l") or ""
  if file then file:close() end
  -- A tab transfer preserves its panes through several socket calls. Let it
  -- finish before a toggle can destroy the popup process.
  if record:match("^%d+ move busy$") then
    local _, alive = hs.execute("/bin/kill -0 " .. record:match("^%d+") .. " 2>/dev/null")
    if alive then return end
  end
  local openMode = record:match("^%d+ (%a+)")
  if not openMode then return openPicker(mode) end
  request("popup.close", nil, function(response)
    os.remove(PIDFILE)
    if response.result and openMode == mode then return end
    openPicker(mode)
  end)
end

local function copyAgentSession(agent, session)
  local name = agent.agent == "codex" and "Codex" or "Claude"
  if not hs.pasteboard.setContents(name .. " session ID " .. session) then
    hs.alert.show("Couldn’t copy the session ID", 2)
    return
  end
  hs.alert.show("Copied " .. name .. " session " .. session:sub(1, 8) .. "…", 1)
end

local function readSessionFile(path, firstLine)
  local file = io.open(path, "r")
  if not file then return end
  local contents = file:read(firstLine and "*l" or "*a")
  file:close()
  local ok, record = pcall(hs.json.decode, contents or "")
  if ok and type(record) == "table" then return record end
end

local function processAgent(process)
  local argv = process.argv or {}
  -- Claude's native binary may have a version number as its process name.
  for _, executable in ipairs({ process.name or "", process.argv0 or "", argv[1] or "" }) do
    local name = executable:match("([^/]+)$")
    if name == "codex" or name == "claude" then return name end
  end
  -- Older npm installations launch the CLI through node.
  local script = argv[2] or ""
  if script:match("/@anthropic%-ai/claude%-code/cli%.js$") then return "claude" end
  if script:match("/@openai/codex/bin/codex%.js$") then return "codex" end
end

-- Agents launched before (or without) SessionStart hooks have no metadata.
-- Use Claude's PID registry or the process's open transcript, never cwd/mtime:
-- multiple agents can be working in the same directory at once.
local function copyProcessSession(paneId, expectedAgent)
  request("pane.process_info", { pane_id = paneId }, function(response)
    local info = response.result and response.result.process_info
    if not info then
      hs.alert.show("Couldn’t inspect the focused Herdr pane", 2)
      return
    end
    local pids, kinds, sessions = {}, {}, {}
    local function addSession(kind, session)
      if type(session) == "string" and session ~= "" then
        sessions[kind .. ":" .. session] = { agent = kind, session = session }
      end
    end
    local function copyFoundSession()
      local key, found = next(sessions)
      if key and not next(sessions, key) then
        copyAgentSession(found, found.session)
        return true
      end
      return false
    end
    for _, process in ipairs(info.foreground_processes or {}) do
      local kind = processAgent(process)
      if kind and process.pid and (not expectedAgent or kind == expectedAgent) then
        local pid = tostring(process.pid)
        pids[#pids + 1] = pid
        kinds[pid] = kind
        if kind == "claude" then
          local record = readSessionFile(HOME .. "/.claude/sessions/" .. pid .. ".json")
          if record and record.pid == process.pid then addSession(kind, record.sessionId) end
        end
      end
    end
    if copyFoundSession() then return end
    if #pids == 0 then
      hs.alert.show("No Claude/Codex process found in the focused pane", 2)
      return
    end
    local task
    task = hs.task.new("/usr/sbin/lsof", function(exitCode, stdout)
      inflight[task] = nil
      local kind
      if exitCode == 0 or exitCode == 1 then
        for line in (stdout or ""):gmatch("[^\r\n]+") do
          local pid = line:match("^p(%d+)$")
          if pid then kind = kinds[pid] end
          local path = line:match("^n(.+)$")
          if kind == "codex" and path and path:match("/rollout%-[^/]+%.jsonl$") then
            local record = readSessionFile(path, true)
            if record and record.type == "session_meta" and type(record.payload) == "table" then
              addSession(kind, record.payload.id)
            end
          elseif kind == "claude" and path and path:match("/projects/[^/]+/[^/]+%.jsonl$") then
            local record = readSessionFile(path, true)
            if record then addSession(kind, record.sessionId) end
          end
        end
      end
      if not copyFoundSession() then
        hs.alert.show("Couldn’t identify one Claude/Codex session in the focused pane", 2)
      end
    end, { "-nP", "-a", "-p", table.concat(pids, ","), "-Fn" })
    if not task then
      hs.alert.show("Couldn’t inspect the focused agent process", 2)
      return
    end
    inflight[task] = true
    if not task:start() then
      inflight[task] = nil
      hs.alert.show("Couldn’t inspect the focused agent process", 2)
    end
  end)
end

local function copySessionId()
  request("session.snapshot", nil, function(response)
    local snap = response.result and response.result.snapshot
    if not snap or not snap.focused_pane_id then
      hs.alert.show("Couldn’t read the focused Herdr pane", 2)
      return
    end
    for _, agent in ipairs(snap.agents or {}) do
      if agent.pane_id == snap.focused_pane_id and (agent.agent == "codex" or agent.agent == "claude") then
        local metadata = agent.agent_session
        local session = metadata and metadata.value
        if metadata and metadata.kind ~= "path" and type(session) == "string" and session ~= "" then
          copyAgentSession(agent, session)
          return
        end
        copyProcessSession(agent.pane_id, agent.agent)
        return
      end
    end
    copyProcessSession(snap.focused_pane_id)
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
