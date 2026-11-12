-- The editor end of cmd/ctrl-click in Rex. Hammerspoon (rexlinks.lua) reads the
-- file location under the click, and `rex-open` finds the floating Neovim (cmd)
-- or the Neovim in the same Rex tab (ctrl) and calls open() over RPC:
--
--   nvim --server <socket> --remote-expr "luaeval('require(\"config.rex_links\").open(_A)', …)"
--
-- Nothing registers: rex-open finds a sibling's socket from the pane's
-- foreground pid (Neovim's default v:servername, …/nvim.<pid>.0).
local M = {}

function M.open(location)
  local stat = type(location.path) == "string" and vim.uv.fs_stat(location.path)
  if not stat or (stat.type ~= "file" and stat.type ~= "directory") then
    return { ok = false, error = "Not found: " .. tostring(location.path) }
  end
  local ok, err = pcall(function()
    vim.cmd.stopinsert()
    -- Use a regular window if a picker or another floating window has focus.
    if vim.api.nvim_win_get_config(0).relative ~= "" then
      for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
        if vim.api.nvim_win_get_config(win).relative == "" then
          vim.api.nvim_set_current_win(win)
          break
        end
      end
    end
    -- Structured arguments keep a filename from becoming an Ex command. No bang:
    -- modified buffers are kept, and the usual abandon rules apply.
    vim.api.nvim_cmd({ cmd = "edit", args = { location.path } }, {})
    if stat.type == "directory" then
      return -- the explorer (or netrw) takes it from here
    end
    local line = math.max(1, math.min(tonumber(location.line) or 1, vim.api.nvim_buf_line_count(0)))
    local text = vim.api.nvim_buf_get_lines(0, line - 1, line, false)[1] or ""
    local column = math.max(0, math.min((tonumber(location.column) or 1) - 1, #text))
    vim.api.nvim_win_set_cursor(0, { line, column })
    vim.cmd("normal! zvzz")
  end)
  if not ok then
    vim.notify(tostring(err), vim.log.levels.WARN, { title = "Rex file link" })
    return { ok = false, error = tostring(err) }
  end
  return { ok = true, path = vim.api.nvim_buf_get_name(0), line = vim.api.nvim_win_get_cursor(0)[1] }
end

return M
