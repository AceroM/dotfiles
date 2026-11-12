-- Hand a code location from nvim to a coding agent in a Rex pane.
--
-- The layout this assumes: nvim runs *inside* a Rex pane (a block), split
-- against the claude it talks to — one tab (a Rex window), claude on one side,
-- this nvim on the other. So the target is simply my sibling: the other agent
-- pane in my tab. No cwd guessing, no remembered state, and it follows me
-- around — open nvim in another tab's split and sends go to that tab's claude.
--
-- Rex has no agent registry of its own, so the pane list comes from
-- `rex-agents --all --json` (cli/.local/bin/rex-agents): every terminal pane with
-- its session, window, block, foreground program, cwd, and the state agents
-- report over OSC 7501. Delivery is `rex send` (typed, no Enter) and the jump is
-- `rex block focus`. Both talk to the Rex server, which they find on their own,
-- so nvim outside Rex works too: with no REX_BLOCK there's no sibling, and
-- resolution falls back to the agent whose cwd contains the file. See resolve()
-- for the full precedence, and :RexTarget to pin one project's sends to one agent.
--
-- Wired up in config/keymaps.lua — both send @path:line (visual: @path:l1-l2)
-- and then put the cursor in the agent's pane:
--   <C-;>  /  <leader>;
--   :RexSend [block_id] / :RexTarget

local M = {}

M.opts = {
  -- Put the cursor in the agent's pane after sending. The reference is the start
  -- of a sentence you finish by hand, so the default is to follow it.
  jump = true,
}

-- The chosen agent is remembered per project root rather than globally: the
-- same chord pressed in two checkouts shouldn't keep re-asking, and shouldn't
-- silently inherit the other checkout's agent either.
M.chosen = {}

local function notify(msg, level)
  vim.notify(msg, level or vim.log.levels.INFO, { title = "rex" })
end

local function trim_err(res)
  local msg = vim.trim((res.stderr or "") ~= "" and res.stderr or (res.stdout or ""))
  return (msg:gsub("^Error: ", ""))
end

-- Run `rex ARGS` without blocking the editor; cb gets the result on the main loop.
local function rex(args, cb)
  local cmd = { "rex" }
  vim.list_extend(cmd, args)
  local ok, err = pcall(vim.system, cmd, { text = true }, function(res)
    vim.schedule(function()
      cb(res)
    end)
  end)
  if not ok then
    cb({ code = 127, stdout = "", stderr = tostring(err) })
  end
end

-- Every terminal pane, not just the agents: nvim's own pane is in the list too,
-- and that is how we learn which tab (window) we're sitting in. A pane is an
-- agent when rex-agents fills in `agent` (claude or codex). Async because
-- rex-agents asks Rex about every pane (~0.5s), which is too long to freeze for.
local function panes(cb)
  local ok, err = pcall(vim.system, { "rex-agents", "--all", "--json" }, { text = true }, function(res)
    vim.schedule(function()
      if res.code ~= 0 then
        return cb(nil, "`rex-agents --all --json` failed: " .. trim_err(res))
      end
      local parsed, list = pcall(vim.json.decode, res.stdout)
      if not parsed or type(list) ~= "table" then
        return cb(nil, "could not parse `rex-agents --all --json` output")
      end
      cb(list)
    end)
  end)
  if not ok then
    cb(nil, "could not run rex-agents: " .. tostring(err))
  end
end

local function is_agent(p)
  return type(p.agent) == "string" and p.agent ~= ""
end

-- Claude resolves @paths against its own cwd, so the agent that can read this
-- file is one whose cwd contains it — and that cwd is what we make it relative
-- to. rex-agents reports cwd without a trailing slash; normalise anyway.
local function contains(cwd, path)
  cwd = cwd and cwd:gsub("/+$", "") or ""
  return cwd ~= "" and (path == cwd or path:sub(1, #cwd + 1) == cwd .. "/")
end

-- Key for M.chosen. `.git` is matched as a file too, so worktrees (service.3
-- and friends) key off the worktree root rather than the main checkout.
local function project_root(path)
  local dir = vim.fs.dirname(path)
  local git = vim.fs.find(".git", { path = dir, upward = true })[1]
  return git and vim.fs.dirname(git) or dir
end

-- The Rex pane this nvim sits in, if any. Inherited from the pane's shell at
-- launch, so nil means "not running under Rex" and every caller has to cope
-- with that. A stale value matches no live pane, so it degrades to the same
-- fallbacks rather than sending somewhere wrong.
local function self_block()
  local b = vim.env.REX_BLOCK
  return b ~= "" and b or nil
end

-- The window (tab) holding `block`, looked up in a rex-agents listing.
local function window_of(list, block)
  for _, p in ipairs(list or {}) do
    if p.block_id == block then
      return p.window_id
    end
  end
end

-- Rex shortens IDs to their last 8 characters (`Window 023f56b0`); so do we.
local function short(id)
  return (id or ""):sub(-8)
end

-- First non-empty string, else "" (rex-agents leaves missing labels empty).
local function first(...)
  for i = 1, select("#", ...) do
    local v = select(i, ...)
    if type(v) == "string" and v ~= "" then
      return v
    end
  end
  return ""
end

local function label(a)
  local where = first(a.session, short(a.session_id)) .. "/" .. first(a.tab, short(a.window_id))
  return ("%-8s %-28s %s"):format(first(a.state, "?"), where, first(a.title, a.cwd))
end

local function pick(list, key, cb)
  vim.ui.select(list, { prompt = "Send reference to:", format_item = label }, function(choice)
    if not choice then
      return
    end
    M.chosen[key] = choice.block_id
    cb(choice)
  end)
end

-- Precedence, most specific intent first:
--   1. a pin set by :RexTarget — you said so explicitly, that outranks layout
--   2. the agent sharing my Rex tab — the pane I am split against. The whole
--      point: it is the claude I am looking at, and it needs no remembered state
--      and no cwd match to be the right answer.
--   3. innermost cwd match, so the reference stays relative and resolvable
--   4. ask
-- Herdr had a single server-wide focused pane to fall back on for nvim running
-- outside it; Rex keeps a focused pane per tab and leaves which session is on
-- screen to the app, so there is no such answer to give and cwd does that job.
-- cb(agent, my_window): my_window is the tab this nvim is in, nil outside Rex.
local function resolve(path, cb)
  panes(function(list, err)
    if not list then
      return notify(err, vim.log.levels.ERROR)
    end
    local agents = vim.tbl_filter(is_agent, list)
    if #agents == 0 then
      return notify("no agent panes are running in rex", vim.log.levels.ERROR)
    end

    local me = self_block()
    local my_window = me and window_of(list, me)
    local function done(a)
      cb(a, my_window)
    end

    local key = project_root(path)
    local by_id = {}
    for _, a in ipairs(agents) do
      by_id[a.block_id] = a
    end

    local remembered = M.chosen[key]
    if remembered and by_id[remembered] then
      return done(by_id[remembered])
    end

    -- The agent next door, in my own tab. Its cwd doesn't have to contain the
    -- file for this to be right — a worktree agent is still the agent I'm split
    -- against, and reference() just falls back to an absolute path. More than
    -- one agent in the tab is ambiguous enough to ask about (once — pick() pins it).
    if my_window then
      local siblings = vim.tbl_filter(function(a)
        return a.window_id == my_window and a.block_id ~= me
      end, agents)
      if #siblings == 1 then
        return done(siblings[1])
      elseif #siblings > 1 then
        return pick(siblings, key, done)
      end
    end

    local cands = vim.tbl_filter(function(a)
      return a.block_id ~= me and contains(a.cwd, path)
    end, agents)
    if #cands > 0 then
      -- Innermost cwd wins: a repo-root agent and a subdirectory agent both
      -- match, but the subdirectory one is the more specific answer.
      table.sort(cands, function(x, y)
        return #x.cwd > #y.cwd
      end)
      local tied = vim.tbl_filter(function(a)
        return #a.cwd == #cands[1].cwd
      end, cands)
      if #tied == 1 then
        return done(tied[1])
      end
      return pick(tied, key, done)
    end

    pick(
      vim.tbl_filter(function(a)
        return a.block_id ~= me
      end, agents),
      key,
      done
    )
  end)
end

-- The trailing space keeps consecutive sends from gluing together, and the
-- ":line" suffix earns its keep twice: a bare "@path" leaves Claude's file
-- mention popup open, and while that popup is open Enter accepts the highlighted
-- completion instead of submitting the prompt. "@path:2044" closes it.
local function reference(path, cwd, l1, l2)
  local rel = contains(cwd, path) and path:sub(#cwd:gsub("/+$", "") + 2) or path
  local lines = (l2 and l2 ~= l1) and (l1 .. "-" .. l2) or tostring(l1)
  return "@" .. rel .. ":" .. lines .. " "
end

-- `rex block focus` moves the server's focus: the agent's block becomes the
-- focused pane of its tab, and that tab its session's active one. That is all
-- it takes when the agent is my sibling, in the tab already on screen. For an
-- agent in another tab or session the app also has to be told to show it —
-- it keeps its own selected session and tab — and the CLI can only ask it to
-- with `rex do session.select`, which Rex.app refuses unless Remote Control is
-- on (Settings → Rex Server). When it refuses, say where the agent is instead.
function M.jump(agent, my_window)
  rex({ "block", "focus", "-s", agent.session_id, agent.block_id }, function(res)
    if res.code ~= 0 then
      return notify("focus failed: " .. trim_err(res), vim.log.levels.WARN)
    end
    if not agent.window_id or agent.window_id == my_window then
      return
    end
    rex({
      "do",
      "session.select",
      "session_id=" .. agent.session_id,
      "window_id=" .. agent.window_id,
    }, function(sel)
      if sel.code ~= 0 then
        notify(
          "focused " .. label(agent) .. " — but the app didn't switch to it: " .. trim_err(sel),
          vim.log.levels.WARN
        )
      end
    end)
  end)
end

--- @param opts? table range: use the visual selection; jump: override M.opts.jump;
---                     target: force a block_id, skipping resolution
function M.send(opts)
  opts = opts or {}
  local jump = opts.jump
  if jump == nil then
    jump = M.opts.jump
  end

  local path = vim.api.nvim_buf_get_name(0)
  if path == "" or vim.bo.buftype ~= "" then
    return notify("current buffer is not a file", vim.log.levels.WARN)
  end
  path = vim.fn.fnamemodify(path, ":p")

  local l1, l2
  if opts.range then
    l1, l2 = vim.fn.line("v"), vim.fn.line(".")
    if l1 > l2 then
      l1, l2 = l2, l1
    end
    vim.api.nvim_feedkeys(vim.keycode("<Esc>"), "n", false)
  else
    l1 = vim.fn.line(".")
  end

  local function deliver(agent, my_window)
    if agent.block_id == self_block() then
      return notify("refusing to send into this nvim's own pane", vim.log.levels.ERROR)
    end
    local text = reference(path, agent.cwd or "", l1, l2)
    -- `--`: the text is never read as an option, whatever it starts with.
    rex({ "send", "-s", agent.session_id, "-b", agent.block_id, "--", text }, function(res)
      if res.code ~= 0 then
        return notify("send failed: " .. trim_err(res), vim.log.levels.ERROR)
      end
      notify(vim.trim(text) .. "  →  " .. label(agent))
      if jump then
        M.jump(agent, my_window)
      end
    end)
  end

  if opts.target then
    return panes(function(list, err)
      if not list then
        return notify(err, vim.log.levels.ERROR)
      end
      -- A full block ID, or any 6+ character piece of one, as rex-agents takes.
      local hits = vim.tbl_filter(function(p)
        return p.block_id == opts.target or (#opts.target >= 6 and p.block_id:find(opts.target, 1, true) ~= nil)
      end, list)
      if #hits == 1 then
        return deliver(hits[1], window_of(list, self_block()))
      elseif #hits > 1 then
        return notify(opts.target .. " matches " .. #hits .. " rex panes; pass more of the ID", vim.log.levels.ERROR)
      end
      notify("no rex pane matches " .. opts.target, vim.log.levels.ERROR)
    end)
  end
  resolve(path, deliver)
end

--- Forget this project's remembered agent and choose again on the next send.
function M.retarget()
  local path = vim.api.nvim_buf_get_name(0)
  if path == "" then
    return notify("current buffer is not a file", vim.log.levels.WARN)
  end
  local key = project_root(vim.fn.fnamemodify(path, ":p"))
  M.chosen[key] = nil
  panes(function(list, err)
    if not list then
      return notify(err, vim.log.levels.ERROR)
    end
    local me = self_block()
    local agents = vim.tbl_filter(function(p)
      return is_agent(p) and p.block_id ~= me
    end, list)
    if #agents == 0 then
      return notify("no agent panes are running in rex", vim.log.levels.ERROR)
    end
    pick(agents, key, function(a)
      notify("sends from " .. vim.fn.fnamemodify(key, ":~") .. " now go to " .. label(a))
    end)
  end)
end

vim.api.nvim_create_user_command("RexSend", function(cmd)
  M.send({ target = cmd.args ~= "" and cmd.args or nil })
end, { nargs = "?", desc = "Send @path:line to a Rex agent pane" })

vim.api.nvim_create_user_command("RexTarget", function()
  M.retarget()
end, { desc = "Choose which Rex agent this project's references go to" })

return M
