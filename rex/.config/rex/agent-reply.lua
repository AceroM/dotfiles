-- Open directly in Rex, so the first thing Cmd+R does is show the float.
-- The Go composer gets the exact block and process it was opened over.
local TERMINAL = "com.superlogical.terminal"
local AGENTS = { codex = "Codex", claude = "Claude" }
local DEFAULT_COLUMNS, MAX_COLUMNS = 38, 48

local function agent_name(value)
  local name = (value or ""):lower():match("[^/]+$")
  if name == "claude-code" then return "claude" end
  if AGENTS[name] then return name end
end

local function identify(block)
  local process = rex.block.call(TERMINAL, "process", { block_id = block })
  local fg = process and process.foreground
  if not fg or not fg.pid then return end
  local name = agent_name(fg.argv0) or agent_name(fg.invoked_path) or agent_name(fg.path) or agent_name(fg.name)
  if not name then
    -- A wrapped agent can still be identified by the foreground owner's status.
    local status = rex.block.call(TERMINAL, "program_status", { block_id = block })
    for _, record in ipairs(status and status.records or {}) do
      if record.owner and record.owner.pid == fg.pid then
        name = agent_name(record.effective_app) or agent_name(record.app)
        if name then break end
      end
    end
  end
  if name then return { pid = fg.pid, agent = name, cwd = fg.cwd } end
end

local function find_rect(node, block)
  if not node then return end
  if node.block_id == block then return node.rect end
  if node.split then return find_rect(node.split.before, block) or find_rect(node.split.after, block) end
end

local function reply_bounds(rect, columns)
  local x, y, w, h = rect[1], rect[2], rect[3], rect[4]
  local width, height = math.min(0.32, w * 0.8), math.min(0.16, h * 0.8)
  if columns and columns > 0 then
    local window_columns = columns / w
    local desired = math.min(MAX_COLUMNS, math.max(DEFAULT_COLUMNS, window_columns * 0.20))
    width = math.min(w * 0.8, desired / window_columns)
  end
  return { x + (w - width) / 2, y + (h - height) / 2, width, height }
end

return function(o_bin, rex_dir)
  rex.action{
    name = "agent_reply",
    title = "Reply to Agent in This Pane",
    category = "Pane",
    keywords = "reply agent Claude Codex floating composer",
    args = { target_only = "boolean?" },
    run = function(ctx, args)
      local block = ctx.block_id
      if not block then return end
      local target = identify(block)
      if args.target_only then return target or { pid = 0 } end
      if not target then return end

      local view, err = rex.session.view{}
      if not view then error(err, 0) end
      for _, window in ipairs(view.windows or {}) do
        for _, layer in ipairs(window.layers or {}) do
          local rect = find_rect(layer.layout, block)
          if rect then
            if window.zoomed_block_id == block then rect = { 0, 0, 1, 1 } end
            local size = rex.block.call(TERMINAL, "size", { block_id = block })
            -- Rex restores the pane behind the float when the composer exits.
            -- Explicit CLI targets can start out unfocused.
            if window.focused_block_id ~= block then
              rex.session.focus_block{ block_id = block }
            end
            return rex.call("session.new_layer", {
              session_id = ctx.session_id, window_id = window.window_id,
              bounds = reply_bounds(rect, size and size.columns), focus = true,
              layout = rex.layout.block{
                flavor = TERMINAL .. ".shell", label = "Reply to " .. AGENTS[target.agent],
                options = {
                  shell = "none", login = false, cwd = target.cwd,
                  path_prepend = { rex_dir, "/opt/homebrew/bin", "/usr/local/bin" },
                  command = { o_bin, "--reply-compose", block, tostring(target.pid), target.agent },
                  size = { columns = DEFAULT_COLUMNS, rows = 6 },
                  exit = { quick_exit_threshold_ms = 0 },
                },
              },
            })
          end
        end
      end
    end,
  }

  rex.action{
    name = "agent_reply_send",
    title = "Send a Composed Reply",
    category = "Pane",
    args = { pid = "integer", agent = "string", prompt = "string", pasted = "boolean" },
    run = function(ctx, args)
      local target = ctx.block_id and identify(ctx.block_id)
      if not target or target.pid ~= args.pid or target.agent ~= args.agent then
        return { error = "The original agent is no longer in this pane" }
      end

      local function event(kind, payload)
        return rex.call("block.event", {
          session_id = ctx.session_id, block_id = ctx.block_id,
          event = { type = kind, payload = payload },
        })
      end
      if not args.pasted then
        if args.prompt:find("\n", 1, true) then
          local state = rex.block.call(TERMINAL, "modes", { block_id = ctx.block_id })
          local ready = false
          for _, mode in ipairs(state and state.modes or {}) do
            if mode.name == "bracketed_paste" and mode.set then ready = true break end
          end
          if not ready then return { error = "Agent is not ready for a multiline reply" } end
        end
        local sent, err = event("paste", { text = args.prompt })
        if not sent then return { error = err or "Could not paste the reply" } end
      end
      local sent = event("key", {
        key = "enter", action = "press", mods = "", consumed_mods = "",
        text = "", unshifted_codepoint = 0, composing = false,
      })
      if not sent then return { pasted = true, error = "Pasted into the agent. Press Enter to retry submission." } end
      return { pasted = true }
    end,
  }
end
