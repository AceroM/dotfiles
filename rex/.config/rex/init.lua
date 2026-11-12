-- Rex config. Reload with: rex config reload

-- Panes: Rex's default cmd+option+arrows move focus between panes (and
-- cmd+[ / cmd+] cycle them). option+left/right stay unbound so they reach
-- the shell as word movement.

-- Undo / redo as in a text field. cmd+z sends ctrl+/ (^_), which is undo in
-- zsh and in Claude Code's prompt. cmd+shift+z sends F20, which zsh binds to
-- redo (zsh/.config/zsh/line-editing.zsh); other programs ignore it.
rex.bind("cmd+z", "pane.send_key", { key = "ctrl+/" })
rex.bind("cmd+shift+z", "pane.send_key", { key = "f20" })

-- Tabs: cmd+j / cmd+k move to the next / previous tab, cmd+; closes it.
rex.bind("cmd+j", "client.tab.next")
rex.bind("cmd+k", "client.tab.previous")
rex.bind("cmd+;", "client.tab.close")

-- Focus history (focus.lua): the panes I've been in, newest first, for cmd+o
-- and ctrl+alt+a. focus-history.lua (started at the bottom) records the moves
-- the server sees; the actions here record the rest.
local focus = require("focus")

-- Record a move: from the pane the key was pressed in, to the pane being
-- shown when it's known.
local function remember(ctx, session_id, block_id)
  local st = focus.load()
  focus.visit(st, ctx.session_id, ctx.block_id)
  if block_id then focus.visit(st, session_id, block_id) end
  focus.save(st)
end

-- Switching sessions in the app sends the server no event, so the session
-- keys record the pane they leave before handing over to the app's action.
rex.action{
  name = "remember_then",
  title = "Record Pane, Then Act",
  category = "Session",
  run = function(ctx, args)
    remember(ctx)
    rex.client.queue(args.action, args.args)
  end,
}

-- Sessions: cmd+shift+j / cmd+shift+k move to the next / previous session
-- (agents <-> servers), one level up from cmd+j / cmd+k on tabs.
rex.bind("cmd+shift+j", "remember_then", { action = "session.next" })
rex.bind("cmd+shift+k", "remember_then", { action = "session.previous" })

-- cmd+p is the session switcher (was cmd+k; replaces Go to Anything).
rex.bind("cmd+p", "remember_then", { action = "session.switch" })

local TERMINAL = "com.superlogical.terminal"

-- cmd+1 … cmd+8 show that tab of the session you're in, and cmd+9 its last
-- tab, so the count never crosses sessions: cmd+9 in agents is agents' last
-- tab, in servers it's servers'. It reads the tabs from the session the key
-- was pressed in rather than leaving it to the app's own client.tab.goto.
-- Try it without moving: rex do session_tab index=-1 dry_run=1 --json
rex.action{
  name = "session_tab",
  title = "Go to Tab in This Session",
  category = "Tab",
  keywords = "tab number index last session goto jump",
  run = function(ctx, args)
    local view, err = rex.session.view{}
    if not view then error(err, 0) end

    local windows = view.windows or {}
    local index = tonumber(args.index) or -1
    if index < 0 then index = #windows + 1 + index end
    local target = windows[index]
    if not target then return { verdict = "none", tabs = #windows } end

    local result = {
      verdict = "go", session_id = ctx.session_id, window_id = target.window_id,
      label = target.label, index = index, tabs = #windows,
    }
    if args.dry_run then return result end

    remember(ctx, ctx.session_id, target.focused_block_id)
    rex.session.focus_window{ window_id = target.window_id }
    -- The app keeps its own selected tab, so tell it to show this one.
    pcall(rex.client.queue, "session.select", {
      session_id = ctx.session_id,
      window_id = target.window_id,
    })
    return result
  end,
}
for n = 1, 8 do
  rex.bind("cmd+" .. n, "session_tab", { index = n })
end
rex.bind("cmd+9", "session_tab", { index = -1 })

-- The directory a pane is in: its foreground program's, else its shell's,
-- else the last one it reported with OSC 7. Without session_id the pane is in
-- the session the action runs in; a pane in another session needs its
-- session_id, and that session attached first.
local function pane_cwd(block_id, session_id)
  if not block_id then return nil end
  local function call(method)
    if not session_id then return rex.block.call(TERMINAL, method, { block_id = block_id }) end
    local ok, r = pcall(rex.call, "block.method",
      { session_id = session_id, block_id = block_id, method = method })
    return ok and r or nil
  end
  local p = call("process")
  if p then
    if p.foreground and p.foreground.cwd then return p.foreground.cwd end
    for _, a in ipairs(p.ancestors or {}) do
      if a.cwd then return a.cwd end
    end
  end
  local r = call("pwd")
  if r and r.pwd and r.pwd ~= "" then
    local path = r.pwd:gsub("^file://[^/]*", "")
    return (path:gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end))
  end
  return nil
end

-- cmd+n opens a new tab right after the current one (not at the end), in the
-- focused pane's directory, and shows it. It's an action rather than a bound
-- function because only actions can queue client actions, and the Mac app
-- keeps its own selected tab, so it has to be told to show the new one.
rex.action{
  name = "new_tab_here",
  title = "New Tab After Current",
  category = "Tab",
  keywords = "new tab here cwd directory next",
  run = function(ctx, args)
    local view, err = rex.session.view{}
    if not view then error(err, 0) end

    local active_index, after, focused = nil, nil, ctx.block_id
    for i, w in ipairs(view.windows or {}) do
      if w.window_id == view.active_window_id then
        active_index = i
        after = view.windows[i + 1]
        focused = focused or w.focused_block_id
        break
      end
    end

    local created
    created, err = rex.session.new_window{
      focus = true,
      layout = rex.layout.block{
        flavor = TERMINAL .. ".shell",
        options = { cwd = pane_cwd(focused) },
      },
    }
    if not created then error(err, 0) end

    -- With no tab after the active one, the new tab already sits at the end.
    if after then
      rex.session.move_window{
        window_id = created.window_id,
        before_window_id = after.window_id,
      }
    end
    rex.session.focus_window{ window_id = created.window_id }

    -- Ask the app to show it too. pcall: run from the CLI there may be no
    -- client to ask.
    pcall(rex.client.queue, "session.select", {
      session_id = ctx.session_id,
      window_id = created.window_id,
    })
    return { window_id = created.window_id, index = active_index and active_index + 1 }
  end,
}
rex.bind("cmd+n", "new_tab_here")

-- cmd+e shows the orchestrators tab, the first tab of the agents session,
-- where `o` waits for prompts, from any session or tab. It keeps that tab
-- first and labelled "orchestrators" and focuses its o pane. When o isn't
-- running there, it starts it in the directory of the pane cmd+e was pressed
-- in: typed into an idle shell in the tab (cd'ing that shell there), else in
-- a new tab or pane. A first tab holding an agent's chat is never taken over;
-- orchestrators gets a new tab in front of it instead.
-- Try it without moving: rex do orchestrators dry_run=1 --json
local ORCH = { session = "agents", tab = "orchestrators", program = "o" }
local SHELLS = { zsh = true, bash = true, fish = true }
-- A new pane runs o, then a login shell once o exits. set -m gives o its own
-- process group, so Rex reports o (not sh) as the pane's foreground program;
-- without it a pane running o would look like an idle sh.
local O_COMMAND = { "/bin/sh", "-c", 'set -m; o; exec "${SHELL:-/bin/zsh}" -l' }

-- The program in the foreground of a pane, by name: "zsh", "o", "claude".
local function foreground(session_id, block_id)
  local ok, p = pcall(rex.call, "block.method",
    { session_id = session_id, block_id = block_id, method = "process" })
  local fg = ok and p and p.foreground or {}
  local name = fg.argv0 or fg.invoked_path or fg.path or ""
  return (name:match("[^/]*$"):gsub("^%-", ""))
end

local function terminal_panes(session_id, window)
  local panes = {}
  for _, layer in ipairs(window.layers or {}) do
    for _, b in ipairs(layer.blocks or {}) do
      if b.creator_name == TERMINAL then
        table.insert(panes, { block_id = b.block_id, program = foreground(session_id, b.block_id) })
      end
    end
  end
  return panes
end

-- The pane whose program want() accepts, the window's focused pane first.
local function pick(panes, focused, want)
  local found
  for _, p in ipairs(panes) do
    if want(p.program) then
      if p.block_id == focused then return p end
      found = found or p
    end
  end
  return found
end

local function session_named(name)
  for _, s in ipairs(rex.call("session.list", {}).sessions or {}) do
    if s.session_id == name or s.label == name then return s.session_id end
  end
end

rex.action{
  name = "orchestrators",
  title = "Go to Orchestrators",
  category = "Tab",
  keywords = "orchestrators o prompt agents first tab",
  run = function(ctx, args)
    local cwd = pane_cwd(ctx.block_id) or os.getenv("HOME")
    local sid = session_named(args.session or ORCH.session) or ctx.session_id
    -- Reading another session's view takes an attach first.
    local view = (rex.call("session.attach", { session_id = sid }) or {}).view or {}
    local windows = view.windows or {}

    -- The tab already labelled orchestrators, else a first tab holding only
    -- shells and o.
    local tab, panes
    for _, w in ipairs(windows) do
      if w.label == ORCH.tab then tab = w break end
    end
    if not tab and windows[1] then
      local ps = terminal_panes(sid, windows[1])
      local plain = #ps > 0
      for _, p in ipairs(ps) do
        if not (SHELLS[p.program] or p.program == ORCH.program) then plain = false end
      end
      if plain then tab, panes = windows[1], ps end
    end
    panes = panes or (tab and terminal_panes(sid, tab)) or {}

    local focused = tab and tab.focused_block_id
    local o = pick(panes, focused, function(n) return n == ORCH.program end)
    local shell = not o and pick(panes, focused, function(n) return SHELLS[n] end)
    local result = {
      session_id = sid, cwd = cwd,
      window_id = tab and tab.window_id,
      tab = not tab and "new" or tab.label ~= ORCH.tab and "label" or "labelled",
      first = tab ~= nil and windows[1] == tab,
      o = o and "running" or shell and "typed_in_shell" or tab and "new_pane" or "new_tab",
      block_id = (o or shell or {}).block_id,
    }
    if args.dry_run then return result end

    local layout = rex.layout.block{
      flavor = TERMINAL .. ".shell",
      options = { cwd = cwd, command = O_COMMAND },
    }
    if not tab then
      local created = rex.call("session.new_window", { session_id = sid, focus = false, layout = layout })
      tab = { window_id = created.window_id }
      result.window_id, result.block_id = created.window_id, (created.block_ids or {})[1]
    elseif shell then
      -- ctrl+u first clears anything half-typed at the prompt.
      local quoted = "'" .. cwd:gsub("'", "'\\''") .. "'"
      rex.call("block.method", {
        session_id = sid, block_id = shell.block_id, method = "write",
        args = { data = "\21cd -- " .. quoted .. " && o\r" },
      })
    elseif not o then
      local created = rex.call("session.new_split", {
        session_id = sid, anchor_id = focused, direction = "vertical", side = "after", layout = layout,
      })
      result.block_id = (created.block_ids or {})[1]
    end

    if windows[1] and windows[1].window_id ~= tab.window_id then
      rex.call("session.move_window", {
        session_id = sid, window_id = tab.window_id, before_window_id = windows[1].window_id,
      })
    end
    if tab.label ~= ORCH.tab then
      rex.call("session.set_window_label", { session_id = sid, window_id = tab.window_id, label = ORCH.tab })
    end

    remember(ctx, sid, result.block_id or tab.focused_block_id)
    if result.block_id then
      rex.call("session.focus_block", { session_id = sid, block_id = result.block_id })
    else
      rex.call("session.focus_window", { session_id = sid, window_id = tab.window_id })
    end
    -- The app keeps its own selected session and tab, so tell it to show
    -- this one. quiet=1 skips that, to try it on another session unseen.
    if not args.quiet then
      pcall(rex.client.queue, "session.select", { session_id = sid, window_id = tab.window_id })
    end
    return result
  end,
}
rex.bind("cmd+e", "orchestrators")

-- Show a pane in any session: focus it on the server, then tell the app,
-- which keeps its own selected session and tab, to show it.
local function show(target)
  rex.call("session.focus_block", { session_id = target.session_id, block_id = target.block_id })
  pcall(rex.client.queue, "session.select", {
    session_id = target.session_id,
    window_id = target.window_id,
  })
end

-- A pane's window, or nil once it's closed or taken out of its window.
local function window_of(session_id, block_id)
  local function describe()
    local ok, r = pcall(rex.call, "session.describe_block",
      { session_id = session_id, block_id = block_id })
    return ok and r and r.block
  end
  local b = describe()
  if not b then
    -- Another session's blocks may need an attach first.
    pcall(rex.call, "session.attach", { session_id = session_id })
    b = describe()
  end
  return b and b.placement == "placed" and b.window_id or nil
end

-- cmd+o goes back to the pane I was in before this one, in whatever tab or
-- session it is, like Herdr's last_pane (ctrl+alt+o). Pressed again it comes
-- back, so two panes toggle. History is focus.lua's; closed panes are skipped.
-- Try it without moving: rex do last_pane dry_run=1 --json
rex.action{
  name = "last_pane",
  title = "Go to Last Pane",
  category = "Pane",
  keywords = "last previous recent pane back toggle alt tab history",
  run = function(ctx, args)
    local st = focus.load()
    focus.visit(st, ctx.session_id, ctx.block_id)
    local target
    for _, e in ipairs(st.mru) do
      if e.b ~= ctx.block_id then
        local window_id = window_of(e.s, e.b)
        if window_id then
          target = { session_id = e.s, block_id = e.b, window_id = window_id }
          break
        end
      end
    end
    if not target then return { verdict = "none" } end
    if args.dry_run then return { verdict = "go", target = target } end

    focus.visit(st, target.session_id, target.block_id)
    focus.save(st)
    show(target)
    return { verdict = "go", target = target }
  end,
}
rex.bind("cmd+o", "last_pane")

-- ctrl+alt+a focuses the next agent waiting on me, across every session:
-- blocked agents first, then agents that finished since I last looked at
-- them, most recently finished first. It's Herdr's ctrl+alt+a
-- (~/.local/bin/herdr-agent-attention) ported to Rex.
--
-- Agents report their state to the terminal with OSC 7501, and program_status
-- reads it back. Like rex-agents, only records from the pane's foreground
-- process count, so a dead agent's last "done" doesn't linger.
--
-- Rex's "done" never goes away on its own, unlike Herdr's, so "unseen" comes
-- from focus.lua: done counts while the record's updated_at is later than the
-- last time I was in that pane. Visiting one marks it seen, so done agents
-- drain as I go. Blocked ones stay until answered; presses rotate through
-- them, so two blocked agents alternate instead of the first swallowing every
-- press.
-- Try it without moving: rex do next_agent_waiting dry_run=1 --json
local WAITING = { blocked = 1, done = 2 }

local function agent_status(session_id, block_id)
  local function call(method)
    local ok, r = pcall(rex.call, "block.method",
      { session_id = session_id, block_id = block_id, method = method })
    return ok and r or {}
  end
  local fg = (call("process").foreground or {}).pid
  local root, first
  for _, rec in ipairs(call("program_status").records or {}) do
    local owner = (rec.owner or {}).pid
    if owner == nil or owner == fg then
      first = first or rec
      if not rec.id then root = root or rec end
    end
  end
  return (root or first) or {}
end

local function waiting_agents(seen)
  local queue = {}
  for _, s in ipairs(rex.call("session.list", {}).sessions or {}) do
    -- Reading another session's view takes an attach first.
    local view = (rex.call("session.attach", { session_id = s.session_id }) or {}).view or {}
    for _, w in ipairs(view.windows or {}) do
      for _, layer in ipairs(w.layers or {}) do
        for _, b in ipairs(layer.blocks or {}) do
          if b.creator_name == TERMINAL then
            local rec = agent_status(s.session_id, b.block_id)
            local at = focus.epoch(rec.updated_at) or 0
            -- seen is whole seconds; the extra second keeps a finish just
            -- before I left from counting as one after.
            if rec.state == "blocked"
              or (rec.state == "done" and at > (seen[b.block_id] or 0) + 1) then
              table.insert(queue, {
                session_id = s.session_id, window_id = w.window_id,
                block_id = b.block_id, state = rec.state, at = at,
                updated_at = rec.updated_at,
              })
            end
          end
        end
      end
    end
  end
  table.sort(queue, function(a, b)
    if WAITING[a.state] ~= WAITING[b.state] then return WAITING[a.state] < WAITING[b.state] end
    if a.at ~= b.at then return a.at > b.at end
    return a.block_id < b.block_id
  end)
  return queue
end

rex.action{
  name = "next_agent_waiting",
  title = "Next Agent Waiting",
  category = "Pane",
  keywords = "agent attention blocked done unseen waiting next finished recent",
  run = function(ctx, args)
    local st = focus.load()
    -- The pane I'm in counts as seen, so a done agent here drops out.
    focus.visit(st, ctx.session_id, ctx.block_id)
    local queue = waiting_agents(st.seen)
    local target = queue[1]
    for i, a in ipairs(queue) do
      if a.block_id == ctx.block_id then
        target = #queue > 1 and queue[i % #queue + 1] or nil
        break
      end
    end
    local verdict = not target and (#queue == 0 and "none" or "self") or "go"
    if args.dry_run then return { verdict = verdict, target = target, queue = queue } end

    if target then focus.visit(st, target.session_id, target.block_id) end
    focus.save(st)
    if target then show(target) end
    return { verdict = verdict, target = target }
  end,
}
rex.bind("ctrl+alt+a", "next_agent_waiting")

-- cmd+shift+f folds the sidebar down to the project you're in, and pressing it
-- again unfolds it. The project is the focused pane's git root (a worktree
-- slot is its own project), else its directory. Every session with no pane in
-- that project collapses; sessions with one stay as they are.
--
-- It works per session because that's all the sidebar allows: Rex can't hide
-- a single tab, and the sidebar's own filter matches only tab titles and
-- session names, never a pane's directory. So it's sharpest when a project has
-- its own session, as a ticket's does.
--
-- The sessions it folded are kept in a state file, so the second press
-- unfolds exactly those, even across a config reload.
-- Try it without folding: rex do dir_focus dry_run=1 --json
local DIR_FOCUS_STATE = (os.getenv("HOME") or "") .. "/.local/state/rex/dir-focus.json"

local function read_dir_focus()
  local f = io.open(DIR_FOCUS_STATE, "r")
  if not f then return nil end
  local text = f:read("*a")
  f:close()
  local ok, state = pcall(rex.json.decode, text)
  return ok and type(state) == "table" and state or nil
end

local function write_dir_focus(state)
  if not state then os.remove(DIR_FOCUS_STATE) return end
  rex.exec{ "mkdir", "-p", DIR_FOCUS_STATE:match("^(.*)/") }
  local f = assert(io.open(DIR_FOCUS_STATE, "w"))
  f:write(rex.json.encode(state))
  f:close()
end

-- The nearest directory at or above dir holding a .git (a directory in a
-- repo, a file in a worktree), else dir itself.
local function project_root(dir)
  local d = dir
  while d and d:match("^/.") do
    local f = io.open(d .. "/.git", "r")
    if f then f:close() return d end
    d = d:match("^(.*)/[^/]*$")
  end
  return dir
end

local function inside(path, root)
  return path == root or path:sub(1, #root + 1) == root .. "/"
end

rex.action{
  name = "dir_focus",
  title = "Focus Sidebar on This Project",
  category = "Session",
  keywords = "filter sidebar directory folder project cwd collapse fold sessions toggle",
  run = function(ctx, args)
    -- Only the app can fold a session, and a run from the CLI (origin "api")
    -- has no app to ask: the folds would go nowhere while the state file
    -- recorded them.
    local live = not args.dry_run
    if live and ctx.origin == "api" then
      error("press the key in Rex: from the CLI there's no app to fold sessions in (try dry_run=1)", 0)
    end

    local state = read_dir_focus()
    if state then
      local result = { verdict = "off", root = state.root, expanded = state.labels }
      if not live then return result end
      for _, sid in ipairs(state.collapsed or {}) do
        pcall(rex.client.queue, "session.expand", { session_id = sid })
      end
      write_dir_focus(nil)
      return result
    end

    local cwd = pane_cwd(ctx.block_id)
    if not cwd then error("can't tell which directory the focused pane is in", 0) end
    local root = project_root(cwd)
    local keep, fold, fold_labels = {}, {}, {}
    for _, s in ipairs(rex.call("session.list", {}).sessions or {}) do
      local sid = s.session_id
      -- The focused pane's own session is in the project by definition.
      local hit = sid == ctx.session_id
      if not hit then
        -- Reading another session's view takes an attach first.
        local view = (rex.call("session.attach", { session_id = sid }) or {}).view or {}
        for _, w in ipairs(view.windows or {}) do
          for _, layer in ipairs(w.layers or {}) do
            for _, b in ipairs(layer.blocks or {}) do
              if not hit and b.creator_name == TERMINAL then
                local dir = pane_cwd(b.block_id, sid)
                hit = dir ~= nil and inside(dir, root)
              end
            end
          end
        end
      end
      if hit then
        table.insert(keep, s.label or sid)
      else
        table.insert(fold, sid)
        table.insert(fold_labels, s.label or sid)
      end
    end

    local result = { verdict = "on", root = root, keep = keep, collapsed = fold_labels }
    if #fold == 0 then result.verdict = "nothing" return result end
    if not live then return result end

    for _, sid in ipairs(fold) do
      rex.client.queue("session.collapse", { session_id = sid })
    end
    write_dir_focus({ root = root, collapsed = fold, labels = fold_labels })
    return result
  end,
}
rex.bind("cmd+shift+f", "dir_focus")

-- cmd+shift+n opens a new session.
rex.bind("cmd+shift+n", "session.new")

-- cmd+y copies the ID of the focused pane (instead of Quick Look).
rex.bind("cmd+y", "pane.copy_id")

-- ctrl+alt+; and ctrl+alt+\ keep Herdr's chords for two dotfiles scripts:
--   ctrl+alt+;  ~/.local/bin/rex-agent-tab: a new tab right after this one
--               running the same agent (claude or codex, same flags) as the
--               pane the key was pressed in, else a shell in its folder.
--   ctrl+alt+\  ~/.local/bin/rex-stash: this session's agents (session id,
--               agent, title, cwd) as a Markdown table in
--               ~/.local/share/rex-stash/. It shows nothing; the action returns
--               the file's path (rex do stash_session).
-- The server's own environment may not have ~/.local/bin or rex on PATH, so
-- the scripts get an explicit one.
local SCRIPT_HOME = os.getenv("HOME") or ""
local SCRIPT_PATH = table.concat({
  SCRIPT_HOME .. "/.local/bin",
  SCRIPT_HOME .. "/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS",
  "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
}, ":")

local function run_script(name, args)
  local argv = { "/usr/bin/env", "PATH=" .. SCRIPT_PATH, SCRIPT_HOME .. "/.local/bin/" .. name }
  for _, a in ipairs(args) do argv[#argv + 1] = a end
  local r = rex.exec(argv)
  if not (r and r.ok) then
    local why = r and ((r.stderr or "") ~= "" and r.stderr or r.stdout) or "didn't run"
    error(name .. ": " .. tostring(why):gsub("%s+$", ""), 0)
  end
  return r.stdout or ""
end

rex.action{
  name = "agent_tab_here",
  title = "New Agent Tab After Current",
  category = "Tab",
  keywords = "agent claude codex new tab same flags mirror",
  run = function(ctx, args)
    local block = ctx.block_id
    if not block then
      local view = rex.session.view{} or {}
      for _, w in ipairs(view.windows or {}) do
        if w.window_id == view.active_window_id then block = w.focused_block_id end
      end
    end
    if not block then error("no focused pane to mirror", 0) end

    local out = rex.json.decode(run_script("rex-agent-tab",
      { "-s", ctx.session_id, "-b", block, "--json" }))
    -- The app keeps its own selected tab, so tell it to show the new one.
    pcall(rex.client.queue, "session.select", {
      session_id = ctx.session_id,
      window_id = out.window_id,
    })
    return out
  end,
}
rex.bind("ctrl+alt+;", "agent_tab_here")

rex.action{
  name = "stash_session",
  title = "Stash This Session's Agents",
  category = "Session",
  keywords = "stash agents markdown table save session",
  run = function(ctx)
    local path = run_script("rex-stash", { "-s", ctx.session_id }):gsub("%s+$", "")
    return { path = path }
  end,
}
rex.bind("ctrl+alt+\\", "stash_session")

-- Pane headers show "<directory>  <title>": pane-labels.lua is a long-running
-- script, so start it detached, once (the [r] keeps this shell from matching).
local REX_BIN = "/Users/miguelacero/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex"
rex.exec.start({
  "/bin/sh", "-c",
  "pgrep -f '[r]ex do .*pane-labels' >/dev/null || exec '" .. REX_BIN .. "' do '"
    .. (os.getenv("HOME") or "") .. "/.config/rex/pane-labels.lua'",
}, { detach = true })

-- Tab labels stay snake_case ("juno16 web :3046" -> juno16_web_3046) whoever
-- sets them: tab-labels.lua is long-running too, and --all makes it hear
-- sessions created after it starts.
rex.exec.start({
  "/bin/sh", "-c",
  "pgrep -f '[r]ex do .*tab-labels' >/dev/null || exec '" .. REX_BIN .. "' do --all '"
    .. (os.getenv("HOME") or "") .. "/.config/rex/tab-labels.lua'",
}, { detach = true })

-- The focus history behind cmd+o and ctrl+alt+a (focus.lua): focus-history.lua
-- records every tab and pane I land on, across all sessions.
rex.exec.start({
  "/bin/sh", "-c",
  "pgrep -f '[r]ex do .*focus-history' >/dev/null || exec '" .. REX_BIN .. "' do --all '"
    .. (os.getenv("HOME") or "") .. "/.config/rex/focus-history.lua'",
}, { detach = true })
