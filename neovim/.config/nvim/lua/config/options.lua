-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here
vim.opt.relativenumber = true
vim.opt.cmdheight = 0
vim.opt.scrolloff = 0
vim.opt.spell = false
vim.g.lazyvim_prettier_needs_config = false

-- When SSH'd in, route the system clipboard (+ register) through OSC 52 so every
-- yank lands on the clipboard of whatever device I'm sitting at — no per-machine
-- relay. This makes all the existing + mappings (<C-y>, <leader>cp, gcc+, "+y)
-- work remotely too. Paste falls back to the last in-Neovim yank because
-- terminals don't allow OSC 52 *reads* (querying would just block on no reply).
local in_ssh = vim.env.SSH_CONNECTION ~= nil or vim.env.SSH_TTY ~= nil or vim.env.SSH_CLIENT ~= nil
if in_ssh then
  local osc52 = require("vim.ui.clipboard.osc52")
  local function paste_last_yank()
    return vim.split(vim.fn.getreg('"'), "\n", { plain = true })
  end
  vim.g.clipboard = {
    name = "OSC 52",
    copy = { ["+"] = osc52.copy("+"), ["*"] = osc52.copy("*") },
    paste = { ["+"] = paste_last_yank, ["*"] = paste_last_yank },
  }
end
