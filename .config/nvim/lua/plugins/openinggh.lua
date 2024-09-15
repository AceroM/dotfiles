return {
	"Almo7aya/openingh.nvim",
	config = function()
		vim.api.nvim_set_keymap("n", "<Leader>gr", ":OpenInGHRepo <CR>", { silent = true, noremap = true })
		vim.api.nvim_set_keymap("n", "<Leader>go", ":OpenInGHFile <CR>", { silent = true, noremap = true })
		vim.api.nvim_set_keymap("v", "<Leader>gf", ":OpenInGHFileLines <CR>", { silent = true, noremap = true })
	end,
}
