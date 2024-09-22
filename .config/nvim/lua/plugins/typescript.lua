return {
	"pmizio/typescript-tools.nvim",
	lazy = false,
	dependencies = { "nvim-lua/plenary.nvim", "neovim/nvim-lspconfig" },
	opts = {},
	config = function()
		local keymap = vim.keymap.set
		local opts = { noremap = true, silent = true }
		local api = require("typescript-tools.api")
		require("typescript-tools").setup({
			handlers = {
				["textDocument/publishDiagnostics"] = api.filter_diagnostics({ 80006, 1540 }),
			},
		})
		keymap("n", "<leader>ro", ":TSToolsOrganizeImports<CR>", opts)
		keymap("n", "<leader>ru", ":TSToolsRemoveUnusedImports<CR>", opts)
		keymap("n", "<c-l>", ":TSToolsAddMissingImports<CR>", opts)
	end,
}
