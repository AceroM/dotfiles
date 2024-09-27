return {
  {
    "tpope/vim-fugitive",
    lazy = false,
    config = function()
      vim.keymap.set("n", "<leader>gd", ":Ghdiffsplit<CR>")
    end,
  },
  {
    "lewis6991/gitsigns.nvim",
    config = function()
      require("gitsigns").setup()
      vim.keymap.set("n", "<leader>gp", ":Gitsigns preview_hunk<CR>")
      vim.keymap.set("n", "]c", "&diff ? ']c' : ':Gitsigns next_hunk<CR>'", { expr = true })
      vim.keymap.set("n", "[c", "&diff ? '[c' : ':Gitsigns prev_hunk<CR>'", { expr = true })
    end,
  },
  {
    "akinsho/git-conflict.nvim",
    version = "*",
    config = function()
      require("git-conflict").setup()
      vim.keymap.set("n", "[x", ":GitConflictPrevConflict<cr>")
      vim.keymap.set("n", "]x", ":GitConflictNextConflict<cr>")
      vim.keymap.set("n", "<leader>co", ":GitConflictChooseOurs<cr>")
      vim.keymap.set("n", "<leader>ct", ":GitConflictChooseTheirs<cr>")
      vim.keymap.set("n", "<leader>cb", ":GitConflictChooseBoth<cr>")
    end,
  },
}
