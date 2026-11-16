-- rt / rex do tabs / option+cmd+;: tabs from every session, in a Go picker.
-- Use the invoking pane's window: the app's tab and server active_window_id
-- can differ. Never put the popup over an unrelated tab.
rex.action{
  name = "tabs",
  title = "Switch or Close Tabs",
  category = "Tab",
  keywords = "rt tabs picker switch close vim",
  args = { dry_run = "boolean?", client = "string?", current_session = "boolean?" },
  run = function(ctx, args)
    local view, err = rex.session.view{}
    if not view then error(err, 0) end
    local window
    for _, w in ipairs(view.windows or {}) do
      for _, layer in ipairs(w.layers or {}) do
        for _, b in ipairs(layer.blocks or {}) do
          if b.block_id == ctx.block_id then window = w end
        end
      end
    end
    if not window then error("Tabs needs a live Rex pane to open over", 0) end

    -- Pressing the shortcut again reuses the existing picker in this tab.
    for _, layer in ipairs(window.layers or {}) do
      if layer.kind == "floating" then
        for _, b in ipairs(layer.blocks or {}) do
          if b.label == "rt · tabs" then
            if not args.dry_run then rex.session.focus_block{ block_id = b.block_id } end
            return { reused = true, block_id = b.block_id, window_id = window.window_id }
          end
        end
      end
    end

    local command = {
      (os.getenv("HOME") or "") .. "/.local/bin/rt", "--inline",
      "--session", ctx.session_id, "--source-window", window.window_id,
    }
    if args.client then
      command[#command + 1] = "--client"
      command[#command + 1] = args.client
    end
    if args.current_session then command[#command + 1] = "--current-session" end
    local options = {
      window_id = window.window_id, bounds = { 0.02, 0.03, 0.96, 0.94 }, focus = true,
      layout = rex.layout.block{
        flavor = "com.superlogical.terminal.shell", label = "rt · tabs",
        options = { command = command },
      },
    }
    if args.dry_run then return options end
    local created, why = rex.session.new_layer(options)
    if not created then error(why, 0) end
    return created
  end,
}
