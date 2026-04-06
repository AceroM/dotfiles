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

-- Copy current filename only
vim.keymap.set("n", "<leader>cn", function()
  local filename = vim.fn.expand("%:t")
  vim.fn.setreg("+", filename)
  vim.notify("Copied filename: " .. filename)
end, { desc = "Copy current filename" })

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
