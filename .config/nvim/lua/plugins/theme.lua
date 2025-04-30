return {
	{
		"catppuccin/nvim",
		name = "catppuccin",
		priority = 1000,
		config = function()
			require("catppuccin").setup()
			vim.cmd([[colorscheme catppuccin-latte]])
		end,
	},
	-- {
	-- 	"Shatur/neovim-ayu",
	-- 	lazy = false,
	-- 	name = "ayu",
	-- 	priority = 1000,
		-- config = function()
		-- 	require("ayu").setup({ mirage = true })
		-- 	vim.cmd([[colorscheme ayu-mirage]])
		-- end,
	-- },
}
