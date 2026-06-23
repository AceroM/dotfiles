-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

-- Disable swap files
vim.opt.swapfile = false

vim.keymap.set("n", "<BS>", '"_dd')
vim.keymap.set("v", "<BS>", '"_dd')
vim.keymap.set("n", "<CR>", "o<Esc>")
vim.keymap.set("n", "<S-CR>", "O<Esc>")
vim.keymap.set("i", "<S-CR>", "<C-o>o", { noremap = true, silent = true })
vim.keymap.set("n", "<C-a>", "ggVG", { desc = "Select entire file" })
vim.keymap.set("n", "<C-j>", "yyp", { desc = "Copy down" })
vim.keymap.set("n", "<C-k>", "yyP", { desc = "Copy up" })
-- Highlight word under cursor without moving
vim.keymap.set("n", "<F2>", "*N", { desc = "Highlight current word" })
vim.keymap.set("n", "<C-p>", function()
  Snacks.picker.files()
end, { desc = "Find files" })
-- Resume the last picker (e.g. dashboard "p" PR diff) with its previous
-- cursor position/state, so you can jump back in and keep navigating.
vim.keymap.set("n", "<C-g>", function()
  Snacks.picker.resume()
end, { desc = "Resume last picker" })
vim.keymap.set("n", "'", ":bd<CR>", { desc = "Close current buffer" })
vim.keymap.set({ "n", "v" }, "<c-/>", function()
  vim.cmd("normal gcc+")
end, { silent = true, noremap = true })

-- Copy current file's relative path
vim.keymap.set("n", "<leader>cp", function()
  local file_path = vim.fn.expand("%:p")
  local git_root = vim.fn.systemlist("git rev-parse --show-toplevel")[1]
  if git_root and file_path:find(git_root, 1, true) then
    file_path = file_path:sub(#git_root + 2) -- +2 to skip the trailing slash
  end
  vim.fn.setreg("+", file_path)
  vim.notify("Copied relative path: " .. file_path)
end, { desc = "Copy current file's relative path" })

-- Copy current file's relative path
vim.keymap.set("n", "<A-/>", function()
  local file_path = vim.fn.expand("%:p")
  local git_root = vim.fn.systemlist("git rev-parse --show-toplevel")[1]
  if git_root and file_path:find(git_root, 1, true) then
    file_path = file_path:sub(#git_root + 2) -- +2 to skip the trailing slash
  end
  vim.fn.setreg("+", file_path)
  vim.notify("Copied relative path: " .. file_path)
end, { desc = "Copy current file's relative path" })

-- Copy current filename only
vim.keymap.set("n", "<leader>cn", function()
  local filename = vim.fn.expand("%:t")
  vim.fn.setreg("+", filename)
  vim.notify("Copied filename: " .. filename)
end, { desc = "Copy current filename" })

-- Copy entire file to clipboard without moving cursor
vim.keymap.set("n", "<C-y>", function()
  local pos = vim.api.nvim_win_get_cursor(0)
  vim.cmd('silent %y+')
  vim.api.nvim_win_set_cursor(0, pos)
end, { desc = "Copy entire file to clipboard", silent = true })

-- Send to the clipboard of whatever device I'm physically on, via OSC 52.
-- Unlike an `ssh box pbcopy` relay (which only ever targets one fixed machine),
-- OSC 52 rides the terminal connection back to the device in front of me — Mac,
-- Windows Terminal, Android (Termux), iOS (Blink) — so it adapts to wherever I
-- SSH'd from, with zero per-machine setup. Forced directly here (not via the +
-- register) so it works the same locally and remotely. Needs the terminal
-- emulator (and any tmux in between) to honor OSC 52 — see the tmux `Ms` override.
local function osc52_send(lines)
  require("vim.ui.clipboard.osc52").copy("+")(lines)
end

vim.keymap.set("n", "<leader>y", function()
  osc52_send(vim.api.nvim_buf_get_lines(0, 0, -1, false))
  vim.notify("Sent buffer to local clipboard (OSC 52)")
end, { desc = "Send buffer to local clipboard (OSC 52)" })

vim.keymap.set("v", "<leader>y", function()
  vim.cmd('noautocmd normal! "zy')
  osc52_send(vim.split(vim.fn.getreg("z"), "\n", { plain = true }))
  vim.notify("Sent selection to local clipboard (OSC 52)")
end, { desc = "Send selection to local clipboard (OSC 52)" })

vim.keymap.set("n", "<C-;>", 'ggdG', { desc = "Clear entire file" })
vim.keymap.set("n", "<A-Down>", "<C-d>", { desc = "Half-page down" })
vim.keymap.set("n", "<A-Up>", "<C-u>", { desc = "Half-page up" })

-- Toggle inline visibility of all git hunks in the current file
-- (line highlight + inline deleted lines + word-level diff)
local git_hunks_shown = false
vim.keymap.set("n", "<leader>gH", function()
  local ok, gs = pcall(require, "gitsigns")
  if not ok then
    return
  end
  git_hunks_shown = not git_hunks_shown
  gs.toggle_linehl(git_hunks_shown)
  gs.toggle_deleted(git_hunks_shown)
  gs.toggle_word_diff(git_hunks_shown)
  gs.refresh()
  vim.notify("Git hunks " .. (git_hunks_shown and "shown" or "hidden"))
end, { desc = "Toggle visibility of all git hunks" })

-- Go to definition in vertical/horizontal splits
vim.keymap.set(
  "n",
  "gv",
  "<cmd>vsplit | lua vim.lsp.buf.definition()<CR>",
  { desc = "Go to definition in vertical split" }
)
vim.keymap.set(
  "n",
  "gh",
  "<cmd>split | lua vim.lsp.buf.definition()<CR>",
  { desc = "Go to definition in horizontal split" }
)
