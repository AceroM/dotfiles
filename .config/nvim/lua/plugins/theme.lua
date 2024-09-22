return {
	{
		"Shatur/neovim-ayu",
		lazy = false,
		name = "ayu",
		priority = 1000,
		config = function()
			require("ayu").setup({ mirage = true })
			vim.cmd([[colorscheme ayu-mirage]])
		end,
	},
}
