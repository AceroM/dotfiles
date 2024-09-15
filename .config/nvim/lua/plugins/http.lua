return {
	"mistweaverco/kulala.nvim",
	config = function()
		vim.filetype.add({
			extension = {
				["http"] = "http",
			},
		})
		vim.keymap.set("n", "<c-\\>", ':w<cr>:lua require("kulala").run()<cr>')
	end,
}
