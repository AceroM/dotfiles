return {
	{
		"tpope/vim-fugitive",
		event = "BufRead",
		config = function()
			vim.keymap.set("n", "<leader>gd", ":Ghdiffsplit<CR>")
		end,
	},
	{
		"lewis6991/gitsigns.nvim",
		lazy = false,
		config = function()
			require("gitsigns").setup()
			vim.keymap.set("n", "<leader>gp", ":Gitsigns preview_hunk<CR>")
			vim.keymap.set("n", "]x", ":Gitsigns next_hunk<CR>")
			vim.keymap.set("n", "[x", ":Gitsigns prev_hunk<CR>")
		end,
	},
	{
		"akinsho/git-conflict.nvim",
		event = "BufRead",
		version = "*",
		config = function()
			require("git-conflict").setup()
			vim.keymap.set("n", "<leader>co", ":GitConflictChooseOurs<cr>")
			vim.keymap.set("n", "<leader>ct", ":GitConflictChooseTheirs<cr>")
			vim.keymap.set("n", "<leader>cb", ":GitConflictChooseBoth<cr>")
		end,
	},
}
