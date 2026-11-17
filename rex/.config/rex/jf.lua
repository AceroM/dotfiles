-- fn+d opens jf (jv --flat: the current branch's PR diff, local changes
-- when the branch has no PR) in a floating pane centred over the tab, in the
-- directory of the pane the key was pressed in, and focuses it.
--
-- Pressed again inside it, it closes it. Pressed in another pane of a tab that
-- already has one, it brings that one back up and focuses it (r in jf reloads
-- the diff). jf runs with --popup: Esc quits once there's nothing left to
-- clear, and an empty diff or a gh error stays on screen until a key instead
-- of closing the float under the message. In jf, t shows / hides test files.
--
-- fn+d reaches Rex as ctrl+alt+d: Hammerspoon's fn layer (herdrkeys.lua) turns
-- fn chords into ctrl+alt ones, as for the rest of keys.lua.
-- Try it without opening anything: rex do jf_float dry_run=1 --json

local dirfocus = require("dir-focus")

local HOME = os.getenv("HOME") or ""
local TERMINAL = "com.superlogical.terminal"
local BOUNDS = { 0.05, 0.05, 0.9, 0.9 } -- x, y, w, h as fractions of the tab
-- A login zsh, so jf finds gh, git and the build tools (the server's PATH is minimal).
-- exec leaves jv as the pane's program, which is how a second press finds it.
local COMMAND = { "/bin/zsh", "-lc", "exec '" .. HOME .. "/.local/bin/jf' --popup" }

-- The program in the foreground of a pane, by name: "zsh", "jv".
local function program(session_id, block_id)
  local ok, p = pcall(rex.call, "block.method",
    { session_id = session_id, block_id = block_id, method = "process" })
  local fg = ok and p and p.foreground or {}
  local name = fg.argv0 or fg.invoked_path or fg.path or ""
  return (name:match("[^/]*$"):gsub("^%-", ""))
end

rex.action{
  name = "jf_float",
  title = "PR Diff (jf) in a Centered Float",
  category = "Pane",
  keywords = "jf jv diff pr pull request review float floating popup center tests",
  args = { dry_run = "boolean?" },
  run = function(ctx, args)
    local view, err = rex.session.view{}
    if not view then error(err, 0) end

    -- The tab holding the pane the key was pressed in: the server's active
    -- window doesn't follow the app's selected tab.
    local window, here
    for _, w in ipairs(view.windows or {}) do
      if w.window_id == view.active_window_id and not window then window = w end
      for _, layer in ipairs(w.layers or {}) do
        for _, b in ipairs(layer.blocks or {}) do
          if b.block_id == ctx.block_id then window, here = w, layer end
        end
      end
    end
    if not window then error("jf: no tab to open over", 0) end

    local open
    for _, layer in ipairs(window.layers or {}) do
      if layer.kind == "floating" then
        for _, b in ipairs(layer.blocks or {}) do
          if program(ctx.session_id, b.block_id) == "jv" then open = layer end
        end
      end
    end

    local cwd = (ctx.block_id and dirfocus.pane_cwd(ctx.block_id)) or HOME
    local result = {
      window_id = window.window_id, cwd = cwd, bounds = BOUNDS,
      does = open and (open == here and "close" or "focus") or "open",
      layer_id = open and open.layer_id or nil,
    }
    if args.dry_run then return result end

    if open and open == here then
      rex.call("session.close_layer", { session_id = ctx.session_id, layer_id = open.layer_id })
    elseif open then
      rex.call("session.set_layer_state", {
        session_id = ctx.session_id, layer_id = open.layer_id, state = "normal", focus = true,
      })
    else
      local created = rex.call("session.new_layer", {
        session_id = ctx.session_id,
        window_id = window.window_id,
        bounds = BOUNDS,
        focus = true,
        layout = rex.layout.block{
          flavor = TERMINAL .. ".shell", label = "jf", options = { cwd = cwd, command = COMMAND },
        },
      })
      result.layer_id = created.layer_id
      result.block_id = (created.block_ids or {})[1]
    end
    return result
  end,
}
rex.bind("ctrl+alt+d", "jf_float")
