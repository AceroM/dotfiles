-- fn shortcuts for Herdr, from a raw keyDown tap (hs.hotkey can't bind fn).
--
--   fn+a          focus the next agent needing attention (from any app)
--   fn+shift+a    toggle the quick agents picker (from any app)
--   fn+s          toggle the quick spaces picker (from any app)
--   fn+m          move the current tab to a numbered space (from any app)
--   fn+t          toggle the tabs picker (every tab in every space)
--   fn+;          toggle the Jev agent search (miguel.jev-focus): rank live
--                 agents by task/topic; Enter focuses one
--   fn+shift+;    toggle the recent Claude/Codex sessions picker; Enter
--                 resumes one in a new tab with permissions bypassed
--   fn+/          toggle the grep picker: filter every other pane's visible
--                 screen (no scrollback) line by line; Enter focuses that pane
--   fn+y          copy the focused pane's Herdr pane id
--   fn+shift+y    copy just the session ID for the focused pane
--   fn+\          stash the focused space: herdr-stash writes its agents
--                 (session id | agent | title | cwd) to a Markdown table in
--                 ~/.local/share/herdr-stash/. The space itself is left alone
--   fn+q          toggle Quick Record's region recording (from any app)
--   fn+shift+q    same, but also records microphone + system audio
--   fn+b          toggle horizontal wheel/trackpad scrolling (from any app)
--   fn+p          put the focused pane's Claude or Codex into plan mode:
--                 presses shift+tab until its footer says plan (Claude cycles
--                 bypass/auto/manual/accept edits/plan, Codex Default/Plan),
--                 so a half-typed prompt is left alone
--   fn+x/w/o/i    become ctrl+alt+x/w/o/i in Herdr: close tab, close pane,
--                 last pane back/forth
--   fn+shift+w    becomes ctrl+alt+shift+w in Herdr: close workspace
--   fn+h/l        become ctrl+alt+h/l in Herdr: previous / next tab
--   fn+1..8       become ctrl+alt+1..8 in Herdr: jump to the Nth tab
--   fn+shift+1..8 become cmd+alt+shift+1..8 in Herdr: jump to the Nth space
--   fn+9         focus the last tab in the current space
--   fn+shift+9   focus the last space in the sidebar
--   fn+j/k        become ctrl+alt+j/k in Herdr: next / previous space
--   fn+shift+j/k  become ctrl+alt+shift+j/k in Herdr: next / previous agent
--   fn+cmd+1..8   focus the Nth agent tab (from any app). Agent tabs are the
--                 tabs hosting at least one agent, across every space, in
--                 sidebar order: one stop per tab, however many agents it holds
--   fn+cmd+9      focus the last agent tab
--   fn+cmd+j/k    focus the next / previous agent tab, wrapping around; from
--                 a tab without an agent, the nearest one in that direction
--   fn+d / fn+-   become ctrl+alt+v / ctrl+alt+minus in Herdr: split
--                 vertically / horizontally
--   fn+z          becomes ctrl+alt+z in Herdr: zoom the pane
--   fn+c          becomes ctrl+alt+b in Herdr: toggle the sidebar
--   fn+r          becomes ctrl+alt+r in Herdr: rename tab
--   fn+shift+r    becomes ctrl+alt+shift+r in Herdr: rename space
--   fn+n          becomes ctrl+alt+n in Herdr: new tab
--   fn+e          opens a tab immediately to the right of the current tab
--   fn+shift+n    becomes ctrl+alt+shift+n in Herdr: new space
--   fn+arrows     become ctrl+alt+arrows in Herdr: focus the pane that way.
--                 macOS has already turned fn+arrow into home/end/pgup/pgdn
--                 by the time the tap sees it, so those keycodes are mapped
--                 back to arrows (outside Herdr they keep their usual job)
--   fn+shift+up/down  page up / down in the focused pane: arrive as plain
--                 pgup/pgdn, which is what fn+up/down sent before Herdr took
--                 them (outside Herdr they stay shift+pgup/pgdn)
--   ctrl+alt+;    (and +shift) handled here too while Herdr is focused, so
--                 Herdr's own binding -- a slower shell hop -- is only a fallback
--
-- "In Herdr" means either Herdr is focused: the TUI in Ghostty, or the desktop
-- app (~/Applications/Herdr.app). The TUI reads its chords from
-- ~/.config/herdr/config.toml, the app from ~/.config/herdr-app/keys.json.
-- The app runs on herdr-core rather than herdr.sock, so the socket features
-- go through its CLI there: fn+a, fn+9, fn+e, fn+y, and the agents/spaces/
-- tabs pickers (its one picker). fn+o/i, fn+m, fn+p, fn+/, fn+;, fn+\ and
-- fn+shift+;/y have no counterpart in the app.
--
-- Everything talks to the Herdr socket via nc: every spawned process costs
-- ~20-30ms on this machine, and the pickers used to chain nine of them.
--
-- Usage from init.lua:
--   herdrkeys = require("herdrkeys")
--   herdrkeys.start()

local M = {}
local horizontalScroll = require("horizontalscroll")

local HOME = os.getenv("HOME")
local socket
local socketCheckedAt = 0
local PIDFILE = HOME .. "/.cache/herdr-quick-picker.pid"
local GHOSTTY = "com.mitchellh.ghostty"
local HERDR_APP = "dev.herdr.app" -- ~/Applications/Herdr.app, the desktop app
local HERDR_APP_CLI = HOME .. "/.local/bin/herdr-app"
local PLUGIN = "miguel.quick-pickers"
local JEV_PLUGIN = "miguel.jev-focus"
local WIDTH = 40 -- ~300px at font-size 14
local SESSIONS_WIDTH = 110 -- title + cwd + age
local SESSIONS_ROWS = 20 -- sessions.ts LIMIT
local GREP_WIDTH = 120 -- long screen lines + location
local JEV_WIDTH = 110 -- agent title + space / tab location

local keys = hs.keycodes.map
local pickers = { [keys.a] = "agents", [keys.s] = "spaces", [keys.m] = "move", [keys.t] = "tabs", [keys[";"]] = "jev", [keys["/"]] = "grep" }
local remapped = {
  [keys.x] = true, [keys.w] = true, [keys.o] = true, [keys.i] = true,
  [keys.h] = true, [keys.j] = true, [keys.k] = true, [keys.l] = true,
  [keys["-"]] = true, [keys.n] = true, [keys.r] = true,
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
-- ctrl+alt+shift+n), fn+shift+a -> agents picker, or fn+shift+y -> copy the session id.
local shiftable = {
  [keys.a] = true, [keys.j] = true, [keys.k] = true,
  [keys.n] = true, [keys.q] = true, [keys.r] = true, [keys.w] = true, [keys.y] = true,
  [keys[";"]] = true, -- fn+shift+; -> sessions picker
}
local workspaceKeys = {}
for number = 1, 9 do
  local code = keys[tostring(number)]
  workspaceKeys[code] = true
  shiftable[code] = true
end
-- fn+cmd chords: which agent tab each one targets.
local agentTabKeys = { [keys["9"]] = "last", [keys.j] = "next", [keys.k] = "prev" }
for number = 1, 8 do agentTabKeys[keys[tostring(number)]] = number end

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

local function toggleRecording(withAudio)
  local task
  task = hs.task.new("/usr/bin/open", function(exitCode, _, stderr)
    inflight[task] = nil
    if exitCode ~= 0 then
      hs.printf("Quick Record toggle failed: %s", stderr or "")
      hs.alert.show("Couldn’t open Quick Record. Run its install.sh first.", 3)
    end
  end, { "-g", "-a", HOME .. "/Applications/Quick Record.app", withAudio and "quickrecord://toggle-audio" or "quickrecord://toggle" })
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

-- Two Herdrs: the TUI inside Ghostty, and the desktop app. The focused one is
-- in use; from any other app, the desktop app wins while it is open.
local function frontEnd()
  local win = hs.window.focusedWindow()
  local app = win and win:application()
  local id = app and app:bundleID()
  if id == GHOSTTY or id == HERDR_APP then return id end
  return hs.application.get(HERDR_APP) and HERDR_APP or GHOSTTY
end

local function herdrFocused()
  local win = hs.window.focusedWindow()
  local app = win and win:application()
  local id = app and app:bundleID()
  return id == GHOSTTY or id == HERDR_APP
end

local function bringForward(id)
  if not herdrFocused() then hs.task.new("/usr/bin/open", nil, { "-b", id }):start() end
end

-- The desktop app runs its terminals on herdr-core, not on the server behind
-- herdr.sock, so everything below that talks to the socket would act on the
-- TUI's session instead. The app is driven through its own CLI (~15ms a
-- call), spooled through a file for the same 64KB reason as requestOnSocket.
-- cb(decoded JSON), or cb(nil) when the call failed.
local function appRun(args, cb)
  local out = os.tmpname()
  local task
  task = hs.task.new("/bin/sh", function(exitCode)
    inflight[task] = nil
    local file = io.open(out, "r")
    local raw = file and file:read("*a") or ""
    if file then file:close() end
    os.remove(out)
    local ok, response = pcall(hs.json.decode, raw)
    if exitCode ~= 0 or not ok or type(response) ~= "table" then
      hs.printf("herdr-app %s failed: %s", table.concat(args, " "), raw)
      if cb then cb(nil) end
      return
    end
    if cb then cb(response) end
  end, { "-c", 'out="$1" cli="$2"; shift 2; exec "$cli" "$@" > "$out" 2>/dev/null', "sh", out, HERDR_APP_CLI, table.unpack(args) })
  if not task then
    os.remove(out)
    if cb then cb(nil) end
    return
  end
  inflight[task] = true
  if not task:start() then
    inflight[task] = nil
    os.remove(out)
    if cb then cb(nil) end
  end
end

local function appActiveSpace(ls)
  for _, space in ipairs(ls.spaces or {}) do
    if space.active then return space end
  end
end

-- Every terminal with a pane, in sidebar order.
local function appTerminals(ls)
  local list = {}
  for _, space in ipairs(ls.spaces or {}) do
    for _, tab in ipairs(space.tabs or {}) do
      for _, term in ipairs(tab.terminals or {}) do list[#list + 1] = term end
    end
  end
  return list
end

local function appFocusLast(workspace)
  appRun({ "ls" }, function(ls)
    if not ls then return hs.alert.show("Couldn’t read the Herdr app’s spaces", 2) end
    if workspace then
      local last = ls.spaces and ls.spaces[#ls.spaces]
      if last then appRun({ "do", "space.select", "--id", last.id }) end
      return
    end
    local space, last = appActiveSpace(ls), nil
    for _, tab in ipairs(space and space.tabs or {}) do
      if not tab.settled then last = tab end
    end
    if last then appRun({ "do", "tab.select", "--id", last.id }) end
  end)
end

-- Same rule as herdr-agent-attention: the next blocked agent after the focused
-- pane, else the next done one, wrapping around, so repeated presses rotate.
local function appFocusNextAgent()
  appRun({ "status" }, function(status)
    appRun({ "ls" }, function(ls)
      if not ls then return hs.alert.show("Couldn’t read the Herdr app’s agents", 2) end
      local terms, here = appTerminals(ls), 0
      for i, term in ipairs(terms) do
        if status and term.pane == status.focused_pane then here = i end
      end
      for _, wanted in ipairs({ "blocked", "done" }) do
        local first, after
        for i, term in ipairs(terms) do
          if term.status == wanted then
            first = first or term
            if i > here and not after then after = term end
          end
        end
        local target = after or first
        if target then return appRun({ "do", "agent.focus", "--terminal", target.terminal }) end
      end
      hs.alert.show("No agent is waiting", 1)
    end)
  end)
end

-- The app's tab.new appends; move the new tab in right after the shown one.
local appCreatingTab = false
local function appNewTabNext()
  if appCreatingTab then return end
  appCreatingTab = true
  local function failed(what)
    appCreatingTab = false
    hs.alert.show("Couldn’t open adjacent tab" .. (what and (": " .. what) or ""), 3)
  end
  appRun({ "ls" }, function(ls)
    local space = ls and appActiveSpace(ls)
    local index
    for i, tab in ipairs(space and space.tabs or {}) do
      if tab.active then index = i end
    end
    if not index then return failed() end
    appRun({ "do", "tab.new", "--space", space.id }, function(made)
      if not made or not made.tab then return failed() end
      appRun({ "do", "tab.move", "--id", made.tab, "--index", tostring(index + 1) }, function(moved)
        if not moved then return failed() end
        appCreatingTab = false
      end)
    end)
  end)
end

-- The app has one picker (its own cmd-p) for agents, spaces and tabs; the
-- same key closes it again.
local appPickers = { agents = true, spaces = true, tabs = true }
local function appToggle(mode)
  if not appPickers[mode] then
    return hs.alert.show("That picker isn’t in the Herdr app", 1.5)
  end
  appRun({ "status" }, function(status)
    for _, overlay in ipairs(status and status.overlays or {}) do
      -- status names overlays by mod, not by the id overlay.close takes
      -- (--id picker answers ok and closes nothing), so close the top one.
      if overlay == "picker" then return appRun({ "do", "overlay.close" }) end
    end
    appRun({ "do", "mod.open", "--name", "picker" })
  end)
end

-- The focused terminal's address (t17), what `hc read` and `hc send` take.
local function appCopyTerminal()
  appRun({ "status" }, function(status)
    appRun({ "ls" }, function(ls)
      for _, term in ipairs(ls and appTerminals(ls) or {}) do
        if status and term.pane == status.focused_pane then
          hs.pasteboard.setContents(term.terminal)
          hs.alert.show("Copied terminal " .. term.terminal, 1)
          return
        end
      end
      hs.alert.show("No focused terminal in the Herdr app", 1)
    end)
  end)
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

local function focusLast(workspace)
  if frontEnd() == HERDR_APP then return appFocusLast(workspace) end
  request("session.snapshot", nil, function(response)
    local snap = response.result and response.result.snapshot
    if not snap then
      hs.alert.show("Couldn’t read Herdr’s tabs and spaces", 2)
      return
    end
    -- Snapshot arrays follow display order; numbers are stable identities.
    local target
    for _, item in ipairs((workspace and snap.workspaces or snap.tabs) or {}) do
      if workspace or item.workspace_id == snap.focused_workspace_id then target = item end
    end
    if not target then return end
    local method = workspace and "workspace.focus" or "tab.focus"
    local params = workspace and { workspace_id = target.workspace_id } or { tab_id = target.tab_id }
    request(method, params, function(focused)
      if focused.error then hs.alert.show("Couldn’t focus the last " .. (workspace and "space" or "tab"), 2) end
    end)
  end)
end

-- target: a 1-based position in the agent-tab list, "last", "next" or "prev".
local function focusAgentTab(target)
  local front = frontEnd()
  bringForward(front)
  if front == HERDR_APP then return hs.alert.show("Agent tabs aren’t wired to the Herdr app yet", 1.5) end
  request("session.snapshot", nil, function(response)
    local snap = response.result and response.result.snapshot
    if not snap then return hs.alert.show("Couldn’t read Herdr’s tabs", 2) end
    -- A tab's own agent_status reads "unknown" both for a plain shell and for
    -- an unclassified agent, so membership comes from the agents list.
    local hosts = {}
    for _, agent in ipairs(snap.agents or {}) do hosts[agent.tab_id] = true end
    -- Every tab top to bottom: spaces in sidebar order, each space's tabs in
    -- display order. here is the focused tab's place in agentTabs: its index
    -- when it hosts an agent, else halfway between its neighbours (0.5 when
    -- it comes first or isn't found), so j/k step off a plain tab to the
    -- nearest agent tab either way.
    local agentTabs, here = {}, 0.5
    for _, space in ipairs(snap.workspaces or {}) do
      for _, tab in ipairs(snap.tabs or {}) do
        if tab.workspace_id == space.workspace_id then
          if tab.tab_id == snap.focused_tab_id then here = #agentTabs + 0.5 end
          if hosts[tab.tab_id] then
            agentTabs[#agentTabs + 1] = tab
            if tab.tab_id == snap.focused_tab_id then here = #agentTabs end
          end
        end
      end
    end
    local count = #agentTabs
    if count == 0 then return hs.alert.show("No agent tabs", 1) end
    local index
    if target == "last" then
      index = count
    elseif target == "next" then
      index = math.floor(here) % count + 1
    elseif target == "prev" then
      index = (math.ceil(here) - 2) % count + 1
    elseif target <= count then
      index = target
    else
      return hs.alert.show("Only " .. count .. " agent tab" .. (count == 1 and "" or "s"), 1)
    end
    local tab = agentTabs[index]
    if tab.tab_id == snap.focused_tab_id then return end
    request("tab.focus", { tab_id = tab.tab_id }, function(focused)
      if focused.error then hs.alert.show("Couldn’t focus agent tab " .. (tab.label or tab.tab_id), 2) end
    end)
  end)
end

local creatingTab = false
local function newTabNext()
  if frontEnd() == HERDR_APP then return appNewTabNext() end
  if creatingTab then return end
  creatingTab = true
  local function failed(response)
    creatingTab = false
    local message = response.error and (response.error.message or response.error.code) or "Invalid response"
    hs.printf("Herdr new adjacent tab failed: %s", message)
    hs.alert.show("Couldn’t open adjacent tab: " .. message, 3)
  end
  request("session.snapshot", nil, function(response)
    local snap = response.result and response.result.snapshot
    if not snap then return failed(response) end
    local source
    for _, pane in ipairs(snap.panes or {}) do
      if pane.pane_id == snap.focused_pane_id then source = pane; break end
    end
    if not source then return failed(response) end
    -- Tab numbers are stable identities, not positions. Count only this
    -- workspace's tabs in display order to get the zero-based insertion slot.
    local insertIndex, count = nil, 0
    for _, tab in ipairs(snap.tabs or {}) do
      if tab.workspace_id == source.workspace_id then
        count = count + 1
        if tab.tab_id == source.tab_id then insertIndex = count end
      end
    end
    if not insertIndex then return failed(response) end
    request("tab.create", {
      workspace_id = source.workspace_id,
      cwd = source.foreground_cwd or source.cwd,
      focus = false,
    }, function(created)
      local tab = created.result and created.result.tab
      if not tab then return failed(created) end
      request("tab.move", { tab_id = tab.tab_id, insert_index = insertIndex }, function(moved)
        if moved.error or not moved.result then return failed(moved) end
        request("tab.focus", { tab_id = tab.tab_id }, function(focused)
          if focused.error or not focused.result then return failed(focused) end
          creatingTab = false
        end)
      end)
    end)
  end)
end

local function focusNextAgent()
  local front = frontEnd()
  bringForward(front)
  if front == HERDR_APP then return appFocusNextAgent() end
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
    local params = {
      plugin_id = PLUGIN,
      entrypoint = mode,
      placement = "popup",
      focus = true,
      width = math.min(width, area.width),
      -- rows + query/count/blank/footer + border, capped at 80% of the client
      height = math.min(count + 7, math.floor(area.height * 0.8)),
      env = { QP_SNAPSHOT = raw }, -- the picker skips its own fetch
    }
    if mode == "jev" then
      -- Two lines per agent; the picker loads its own candidates.
      params.plugin_id, params.entrypoint = JEV_PLUGIN, "picker"
      params.width = math.min(JEV_WIDTH, area.width)
      params.height = math.min(#(snap.agents or {}) * 2 + 8, math.floor(area.height * 0.8))
      params.env = { HJ_SOURCE_PANE_ID = snap.focused_pane_id or "" }
    end
    request("plugin.pane.open", params, function(opened)
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
  local front = frontEnd()
  bringForward(front)
  if front == HERDR_APP then return appToggle(mode) end
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
  if not hs.pasteboard.setContents(session) then
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
  if frontEnd() == HERDR_APP then return hs.alert.show("Session IDs aren’t read from the Herdr app yet", 1.5) end
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
  if frontEnd() == HERDR_APP then return appCopyTerminal() end
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

-- Hands herdr-stash the snapshot from this socket (the Ghostty client's), so
-- it stashes the space on screen rather than one in the default session. The
-- snapshot goes through a file: it can run past a pipe's 64KB.
local stashing = false
local function stashSpace()
  if frontEnd() == HERDR_APP then return hs.alert.show("Stashing isn’t wired to the Herdr app yet", 1.5) end
  if stashing then return end
  stashing = true
  request("session.snapshot", nil, function(response, raw)
    local snap = response.result and response.result.snapshot
    if not snap or not snap.focused_workspace_id then
      stashing = false
      return hs.alert.show("Couldn’t read the focused Herdr space", 2)
    end
    local input = os.tmpname()
    local file = io.open(input, "w")
    if not file then
      stashing = false
      return hs.alert.show("Couldn’t stash the space", 2)
    end
    file:write(raw)
    file:close()
    local task
    task = hs.task.new("/bin/sh", function(exitCode, stdout, stderr)
      inflight[task] = nil
      stashing = false
      os.remove(input)
      local summary = (stderr or ""):match("([^\r\n]+)%s*$") or "herdr-stash failed"
      if exitCode ~= 0 then
        hs.printf("herdr-stash failed: %s", stderr or "")
        return hs.alert.show(summary:gsub("^herdr%-stash: ", "Couldn’t stash: "), 3)
      end
      local name = (stdout or ""):match("([^/\r\n]+)%s*$") or ""
      hs.alert.show(summary .. "\n" .. name, 2.5)
    end, {
      "-c", 'exec /usr/bin/python3 "$1" --snapshot - --workspace "$2" < "$3"',
      "sh", HOME .. "/.local/bin/herdr-stash", snap.focused_workspace_id, input,
    })
    if not task then
      stashing = false
      os.remove(input)
      return hs.alert.show("Couldn’t start herdr-stash", 2)
    end
    inflight[task] = true
    if not task:start() then
      inflight[task] = nil
      stashing = false
      os.remove(input)
      hs.alert.show("Couldn’t start herdr-stash", 2)
    end
  end)
end

-- The mode an agent's footer shows, from the screen's last few lines. Claude:
-- "⏸ plan mode on (shift+tab to cycle)", "⏵⏵ bypass permissions on", ...,
-- or no mode line at all in a session without bypass. Codex: "Plan mode
-- (⇧tab to cycle)" at the right of its status line, cut to "Plan mode" in a
-- narrow pane, and nothing in Default mode. Composer lines (›/❯) are skipped
-- so a draft that mentions plan mode isn't read as the mode.
local function agentMode(kind, text)
  local lines = {}
  for line in text:gmatch("[^\r\n]+") do
    if line:find("%S") then lines[#lines + 1] = line end
  end
  for i = #lines, math.max(1, #lines - 2), -1 do
    local line = lines[i]
    if not line:match("^%s*›") and not line:match("^%s*❯") then
      if kind == "claude" then
        local mode = line:match("⏸ (%a[%a ]-) on") or line:match("⏵⏵ (%a[%a ]-) on")
        if mode then return mode end
      elseif line:match("Plan mode%s*$") or line:find("Plan mode (", 1, true) then
        return "plan mode"
      end
    end
  end
  return "default"
end

-- Each shift+tab moves the agent one mode along, so press, wait for the footer
-- to show the next mode, and stop on plan. A press that changes nothing (a
-- Codex turn is running, a menu is open) ends it rather than pressing blind.
-- Two laps of the cycle bound it in case a press is ever missed.
local PLAN_PRESSES = { claude = 10, codex = 4 }
local PLAN_SETTLE = 0.6 -- seconds a press gets to show up in the footer
local planning = false
-- target: a pane id to act on instead of the focused pane (for testing from
-- the hs CLI without moving focus).
local function enterPlanMode(target)
  if not target and frontEnd() == HERDR_APP then return hs.alert.show("Plan mode isn’t wired to the Herdr app yet", 1.5) end
  if planning then return end
  planning = true
  local function finish(message, seconds)
    planning = false
    if message then hs.alert.show(message, seconds or 1) end
  end
  request("session.snapshot", nil, function(response)
    local snap = response.result and response.result.snapshot
    local pane = target or (snap and snap.focused_pane_id)
    if not pane then return finish("Couldn’t read the focused Herdr pane", 2) end
    local kind
    for _, agent in ipairs(snap.agents or {}) do
      if agent.pane_id == pane and (agent.agent == "claude" or agent.agent == "codex") then kind = agent.agent end
    end
    if not kind then return finish("No Claude or Codex in the focused pane", 1.5) end
    local name = kind == "codex" and "Codex" or "Claude"
    local presses = 0
    local function check(previous, started)
      request("pane.read", { pane_id = pane, source = "visible" }, function(read)
        local text = read.result and read.result.read and read.result.read.text
        if not text then return finish("Couldn’t read the focused pane", 2) end
        local mode = agentMode(kind, text)
        if mode == previous then
          if hs.timer.secondsSinceEpoch() - started < PLAN_SETTLE then
            return hs.timer.doAfter(0.05, function() check(previous, started) end)
          end
          return finish(name .. " didn’t change mode" .. (kind == "codex" and " (is a turn running?)" or ""), 2)
        end
        if mode == "plan mode" then
          return finish(presses == 0 and (name .. " is already in plan mode") or (name .. ": plan mode"), 0.8)
        end
        if presses >= PLAN_PRESSES[kind] then return finish("Couldn’t get " .. name .. " into plan mode", 2) end
        presses = presses + 1
        request("pane.send_input", { pane_id = pane, keys = { "shift+tab" } }, function(sent)
          if sent.error then return finish("Couldn’t send shift+tab to " .. name, 2) end
          check(mode, hs.timer.secondsSinceEpoch())
        end)
      end)
    end
    check(nil, 0)
  end)
end

local function handleKey(event)
  local code = event:getKeyCode()
  local flags = event:getFlags()

  if flags.ctrl and flags.alt and not flags.cmd and not flags.shift and code == keys.e then
    if not herdrFocused() then return false end
    if event:getProperty(hs.eventtap.event.properties.keyboardEventAutorepeat) == 0 then newTabNext() end
    return true
  end

  if flags.ctrl and flags.alt and not flags.cmd and code == keys[";"] then
    if not herdrFocused() then return false end
    toggle(flags.shift and "spaces" or "agents")
    return true
  end

  if flags.fn and flags.cmd and not (flags.alt or flags.ctrl or flags.shift) and agentTabKeys[code] then
    if event:getProperty(hs.eventtap.event.properties.keyboardEventAutorepeat) == 0 then
      focusAgentTab(agentTabKeys[code])
    end
    return true
  end

  -- fn+shift+up/down: page the focused pane. Bare fn+arrows went to Herdr pane
  -- focus, so paging moves one modifier over. Drop shift so the pane sees plain
  -- pgup/pgdn (Claude's scroll:pageUp/pageDown); left as shift+pgup, Ghostty
  -- would claim it for adjust_selection and Claude would not match it anyway.
  if flags.fn and flags.shift and not (flags.cmd or flags.alt or flags.ctrl)
    and (code == keys.pageup or code == keys.pagedown) then
    if not herdrFocused() then return false end
    event:setFlags({})
    return false
  end

  if not flags.fn or flags.cmd or flags.alt or flags.ctrl then return false end
  if flags.shift and not shiftable[code] then return false end
  local mode = pickers[code]
  if not mode and code ~= keys.y and code ~= keys.q and code ~= keys.b and code ~= keys.e and code ~= keys.p and code ~= keys["\\"] and not remapped[code] then return false end
  local autorepeat = event:getProperty(hs.eventtap.event.properties.keyboardEventAutorepeat) ~= 0

  if code == keys.q then
    if not autorepeat then toggleRecording(flags.shift) end
    return true
  elseif code == keys.b then
    if not autorepeat then horizontalScroll.toggle() end
    return true
  elseif code == keys.a then
    if not autorepeat then
      if flags.shift then toggle("agents") else focusNextAgent() end
    end
    return true
  elseif mode then
    if code == keys[";"] and flags.shift then mode = "sessions" end
    if not autorepeat then toggle(mode) end
    return true
  elseif code == keys.y then
    if not autorepeat then
      if flags.shift then copySessionId() else copyPaneId() end
    end
    return true
  elseif code == keys["\\"] then
    if not autorepeat then stashSpace() end
    return true
  elseif code == keys.e then
    if not herdrFocused() then return false end
    if not autorepeat then newTabNext() end
    return true
  elseif code == keys.p then
    if not herdrFocused() then return false end
    if not autorepeat then enterPlanMode() end
    return true
  elseif code == keys["9"] then
    if not herdrFocused() then return false end
    if not autorepeat then focusLast(flags.shift) end
    return true
  elseif herdrFocused() then
    -- The desktop app has no last-pane command (fn+o/i); keep ctrl+alt+o/i
    -- out of the shell rather than rewriting them into it.
    if frontEnd() == HERDR_APP and (code == keys.o or code == keys.i) then return true end
    -- Rewrite in place using Herdr's indexed-space chord for shifted digits.
    -- The desktop app binds the same chords in ~/.config/herdr-app/keys.json.
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
  horizontalScroll.start()
  tap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, handleKey)
  tap:start()
  M.tap = tap
  return M
end

M.toggle = toggle
M.toggleJev = function() toggle("jev") end
M.focusNextAgent = focusNextAgent
M.copySessionId = copySessionId
M.copyPaneId = copyPaneId
M.toggleRecording = toggleRecording
M.newTabNext = newTabNext
M.stashSpace = stashSpace
M.focusAgentTab = focusAgentTab
M.enterPlanMode = enterPlanMode

return M
