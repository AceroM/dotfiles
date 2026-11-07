-- Register this editor so Ctrl-clicks in sibling Herdr panes can use RPC.
local M = {}

function M.setup()
  if vim.env.HERDR_ENV ~= "1" or not vim.env.HERDR_PANE_ID or vim.g.herdr_links_registered then
    return
  end
  local socket = vim.env.HERDR_SOCKET_PATH or vim.fn.expand("~/.config/herdr/herdr.sock")
  local directory = vim.fn.stdpath("state") .. "/herdr-nvim/" .. vim.fn.sha256(socket):sub(1, 12)
  vim.fn.mkdir(directory, "p", 448) -- 0700
  local server = vim.v.servername
  if server == "" then
    server = vim.fn.serverstart()
  end
  local registration = directory .. "/" .. vim.env.HERDR_PANE_ID:gsub("[^%w_-]", "_") .. ".json"
  local temporary = registration .. "." .. vim.fn.getpid()
  vim.fn.writefile({ vim.json.encode({
    pane_id = vim.env.HERDR_PANE_ID,
    pid = vim.fn.getpid(),
    server = server,
    herdr_socket = socket,
  }) }, temporary)
  vim.fn.setfperm(temporary, "rw-------")
  assert(vim.uv.fs_rename(temporary, registration))
  vim.g.herdr_links_registered = true
  vim.api.nvim_create_autocmd("VimLeavePre", {
    once = true,
    callback = function()
      local ok, data = pcall(vim.fn.readfile, registration)
      if ok then
        local parsed, entry = pcall(vim.json.decode, table.concat(data, "\n"))
        if parsed and entry.pid == vim.fn.getpid() then
          vim.fn.delete(registration)
        end
      end
    end,
  })
end

function M.open(location)
  local stat = type(location.path) == "string" and vim.uv.fs_stat(location.path)
  if not stat or stat.type ~= "file" then
    return { ok = false, error = "File does not exist: " .. tostring(location.path) }
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
    -- Structured arguments prevent filenames from becoming Ex commands. No bang:
    -- modified buffers are preserved, and normal Neovim abandonment rules apply.
    vim.api.nvim_cmd({ cmd = "edit", args = { location.path } }, {})
    local line = math.max(1, math.min(tonumber(location.line) or 1, vim.api.nvim_buf_line_count(0)))
    local text = vim.api.nvim_buf_get_lines(0, line - 1, line, false)[1] or ""
    local column = math.max(0, math.min((tonumber(location.column) or 1) - 1, #text))
    vim.api.nvim_win_set_cursor(0, { line, column })
    vim.cmd("normal! zvzz")
  end)
  if not ok then
    vim.notify(tostring(err), vim.log.levels.WARN, { title = "Herdr file link" })
    return { ok = false, error = tostring(err) }
  end
  return { ok = true, path = vim.api.nvim_buf_get_name(0), line = vim.api.nvim_win_get_cursor(0)[1] }
end

return M
