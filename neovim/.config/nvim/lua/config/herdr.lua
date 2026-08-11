-- Hand a code location from nvim to a Herdr agent pane.
--
-- The layout this assumes: nvim runs *inside* a Herdr pane, split against the
-- claude it talks to — one tab, claude on one side, this nvim on the other. So
-- the target is simply my sibling: the other agent pane in HERDR_TAB_ID. No cwd
-- guessing, no remembered state, and it follows me around — open nvim in another
-- tab's split and sends go to that tab's claude instead.
--
-- Delivery is by shelling out to `herdr`, whose CLI talks to the Herdr server
-- over IPC and can address any pane on the machine. That also means the older
-- layout still works — nvim in its own Ghostty split, outside Herdr entirely,
-- with no HERDR_* in its environment — so every use of those vars here is
-- optional and falls back to resolving by focus and cwd. See resolve() for the
-- full precedence, and :HerdrTarget to pin one project's sends to one agent.
--
-- Wired up in config/keymaps.lua — both send @path:line (visual: @path:l1-l2)
-- and then put the cursor in the agent's pane:
--   <C-;>  /  <leader>;
--   :HerdrSend [pane_id] / :HerdrTarget

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
  vim.notify(msg, level or vim.log.levels.INFO, { title = "herdr" })
end

local function trim_err(res)
  return vim.trim((res.stderr or "") ~= "" and res.stderr or (res.stdout or ""))
end

-- Every pane, not just the agents: we need the non-agent ones too, so that a
-- focused shell pane is recognised as unsendable rather than missed entirely.
-- Exactly one pane server-wide carries focused=true, and it is Herdr's own UI
-- state. Note what that means once nvim lives in a Herdr pane: the focused pane
-- is *this nvim*, which has no agent, so the focus-based steps of resolve() go
-- quiet on their own and the sibling lookup does the work. Focus only names an
-- agent in the older layout, where Herdr's UI stays parked on the pane you were
-- last on while you type over in the Ghostty split next door.
local function panes()
  local res = vim.system({ "herdr", "pane", "list" }, { text = true }):wait(5000)
  if res.code ~= 0 then
    return nil, "`herdr pane list` failed: " .. trim_err(res)
  end
  local ok, decoded = pcall(vim.json.decode, res.stdout)
  if not ok then
    return nil, "could not parse `herdr pane list` output"
  end
  local list = vim.tbl_get(decoded or {}, "result", "panes") or {}
  local agents = vim.tbl_filter(function(p)
    return p.agent ~= nil and p.agent ~= vim.NIL
  end, list)
  if #agents == 0 then
    return nil, "no agent panes are running in herdr"
  end
  local focused
  for _, p in ipairs(list) do
    if p.focused then
      focused = p
    end
  end
  return agents, focused
end

-- Claude resolves @paths against its own cwd, so the agent that can read this
-- file is one whose cwd contains it — and that cwd is what we make it relative
-- to. Herdr reports cwd without a trailing slash; normalise anyway.
local function contains(cwd, path)
  cwd = cwd and cwd:gsub("/+$", "") or ""
  return cwd ~= "" and (path == cwd or path:sub(1, #cwd + 1) == cwd .. "/")
end

-- Key for M.chosen. `.git` is matched as a file too, so worktrees (tax-holiday.3
-- and friends) key off the worktree root rather than the main checkout.
local function project_root(path)
  local dir = vim.fs.dirname(path)
  local git = vim.fs.find(".git", { path = dir, upward = true })[1]
  return git and vim.fs.dirname(git) or dir
end

-- Which Herdr pane is this nvim itself sitting in, if any? Inherited from the
-- pane's shell at launch, so nil means "not running under Herdr" — the older
-- Ghostty-split layout — and every caller has to cope with that. A stale value
-- (a tmux server outliving the pane it was started in) matches no live pane, so
-- it degrades to the same fallbacks rather than sending somewhere wrong.
local function self_pane()
  return vim.env.HERDR_PANE_ID, vim.env.HERDR_TAB_ID
end

local function label(a)
  return ("%-7s %-8s %s"):format(a.pane_id, a.agent_status or "?", a.terminal_title_stripped or a.cwd or "")
end

local function pick(list, key, cb)
  vim.ui.select(list, { prompt = "Send reference to:", format_item = label }, function(choice)
    if not choice then
      return
    end
    M.chosen[key] = choice.pane_id
    cb(choice)
  end)
end

-- Precedence, most specific intent first:
--   1. a pin set by :HerdrTarget — you said so explicitly, that outranks layout
--   2. the agent sharing my Herdr tab — the pane I am split against. The whole
--      point: it is the claude I am looking at, and it needs no remembered state
--      and no cwd match to be the right answer.
--   3. the focused agent, when its cwd contains the file — for nvim outside
--      Herdr, where there is no sibling to speak of
--   4. innermost cwd match, so the reference stays relative and resolvable
--   5. the focused agent anyway, with an absolute path — better than a prompt
--      when nothing else can address the file
--   6. ask
local function resolve(path, cb)
  local list, focused = panes()
  if not list then
    return notify(focused, vim.log.levels.ERROR) -- second return is the reason
  end

  local key = project_root(path)
  local by_id = {}
  for _, a in ipairs(list) do
    by_id[a.pane_id] = a
  end

  local remembered = M.chosen[key]
  if remembered and by_id[remembered] then
    return cb(by_id[remembered])
  end

  -- The agent next door, in my own tab. Its cwd doesn't have to contain the file
  -- for this to be right — a worktree agent is still the agent I'm split against,
  -- and reference() just falls back to an absolute path. More than one agent in
  -- the tab is ambiguous enough to be worth asking about (once — pick() pins it).
  local me, my_tab = self_pane()
  if my_tab then
    local siblings = vim.tbl_filter(function(a)
      return a.tab_id == my_tab and a.pane_id ~= me
    end, list)
    if #siblings == 1 then
      return cb(siblings[1])
    elseif #siblings > 1 then
      return pick(siblings, key, cb)
    end
  end

  -- focused may be a shell pane, or nothing at all; only an agent can take a prompt
  local active = focused and by_id[focused.pane_id]
  if active and contains(active.cwd, path) then
    return cb(active)
  end

  local cands = vim.tbl_filter(function(a)
    return contains(a.cwd, path)
  end, list)
  if #cands > 0 then
    -- Innermost cwd wins: a repo-root agent and a subdirectory agent both match,
    -- but the subdirectory one is the more specific answer.
    table.sort(cands, function(x, y)
      return #x.cwd > #y.cwd
    end)
    local tied = vim.tbl_filter(function(a)
      return #a.cwd == #cands[1].cwd
    end, cands)
    if #tied == 1 then
      return cb(tied[1])
    end
    return pick(tied, key, cb)
  end

  if active then
    return cb(active) -- no relative path is possible; reference() falls back to absolute
  end
  pick(list, key, cb)
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

-- With nvim inside Herdr there is only one focus system: `agent focus` moves the
-- cursor into that pane (switching tab or workspace if the target is elsewhere),
-- and Ghostty knows nothing about it — pressing its split key here would only
-- throw focus out of the terminal Herdr is filling.
--
-- The older layout has two focus systems to reconcile. Herdr's pane focus has a
-- CLI; Ghostty has no IPC at all, so its split focus goes through Hammerspoon
-- pressing the very super+i that ghostty/config binds to goto_split:next — guarded
-- on Ghostty being frontmost so a stray keystroke can never land in another app's
-- window. (That binding cycles, so it lands right with two splits, not three.)
function M.jump(pane_id)
  vim.system({ "herdr", "agent", "focus", pane_id })
  if select(2, self_pane()) then
    return
  end
  vim.system({
    "hs",
    "-c",
    'local a = hs.application.frontmostApplication()'
      .. ' if a and a:bundleID() == "com.mitchellh.ghostty" then hs.eventtap.keyStroke({"cmd"}, "i") end',
  })
end

--- @param opts? table range: use the visual selection; jump: override M.opts.jump;
---                     target: force a pane_id, skipping resolution
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

  local function deliver(agent)
    local text = reference(path, agent.cwd, l1, l2)
    vim.system({ "herdr", "pane", "send-text", agent.pane_id, text }, { text = true }, function(res)
      vim.schedule(function()
        if res.code ~= 0 then
          return notify("send failed: " .. trim_err(res), vim.log.levels.ERROR)
        end
        notify(vim.trim(text) .. "  →  " .. label(agent))
        if jump then
          M.jump(agent.pane_id)
        end
      end)
    end)
  end

  if opts.target then
    return deliver({ pane_id = opts.target, cwd = M.cwd_of(opts.target) or "" })
  end
  resolve(path, deliver)
end

-- cwd of an arbitrary pane, for an explicitly targeted send.
function M.cwd_of(pane_id)
  local res = vim.system({ "herdr", "pane", "get", pane_id }, { text = true }):wait(5000)
  if res.code ~= 0 then
    return nil
  end
  local ok, decoded = pcall(vim.json.decode, res.stdout)
  return ok and vim.tbl_get(decoded or {}, "result", "pane", "cwd") or nil
end

--- Forget this project's remembered agent and choose again on the next send.
function M.retarget()
  local path = vim.api.nvim_buf_get_name(0)
  if path == "" then
    return notify("current buffer is not a file", vim.log.levels.WARN)
  end
  local key = project_root(vim.fn.fnamemodify(path, ":p"))
  M.chosen[key] = nil
  local list, reason = panes()
  if not list then
    return notify(reason, vim.log.levels.ERROR)
  end
  pick(list, key, function(a)
    notify("sends from " .. vim.fn.fnamemodify(key, ":~") .. " now go to " .. label(a))
  end)
end

vim.api.nvim_create_user_command("HerdrSend", function(cmd)
  M.send({ target = cmd.args ~= "" and cmd.args or nil })
end, { nargs = "?", desc = "Send @path:line to a herdr agent" })

vim.api.nvim_create_user_command("HerdrTarget", function()
  M.retarget()
end, { desc = "Choose which herdr agent this project's references go to" })

return M
