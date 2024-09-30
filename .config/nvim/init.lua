local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"

if not (vim.uv or vim.loop).fs_stat(lazypath) then
	local lazyrepo = "https://github.com/folke/lazy.nvim.git"
	local out = vim.fn.system({ "git", "clone", "--filter=blob:none", "--branch=stable", lazyrepo, lazypath })
	if vim.v.shell_error ~= 0 then
		vim.api.nvim_echo({
			{ "Failed to clone lazy.nvim:\n", "ErrorMsg" },
			{ out, "WarningMsg" },
			{ "\nPress any key to exit..." },
		}, true, {})
		vim.fn.getchar()
		os.exit(1)
	end
end

vim.opt.rtp:prepend(lazypath)

vim.api.nvim_create_autocmd("BufWritePre", {
	pattern = { "*.erb", "*.rb" },
	callback = function()
		local win = vim.api.nvim_get_current_win()
		local cursor = vim.api.nvim_win_get_cursor(win)
		local view = vim.fn.winsaveview()
		vim.cmd("normal! gg=G")
		vim.fn.winrestview(view)
		vim.api.nvim_win_set_cursor(win, cursor)
	end,
})

require("mappings")
require("lazy").setup({
	defaults = { lazy = true },
	spec = {
		{ import = "plugins" },
	},
	install = { colorscheme = { "ayu" } },
	checker = {
		enabled = false,
		concurrency = nil,
		notify = true,
		frequency = 3600,
		check_pinned = false,
	},
	ui = { border = "rounded" },
	performance = {
		cache = {
			enabled = true,
		},
		rtp = {
			disabled_plugins = {
				"netrwPlugin",
				"gzip",
				"tarPlugin",
				"tohtml",
				"tutor",
				"zipPlugin",
			},
		},
	},
	debug = false,
})
