return {
	{
		"Shatur/neovim-ayu",
		name = "ayu",
		priority = 9999,
		config = function()
			vim.cmd([[colorscheme ayu-mirage]])
		end,
	},
}
