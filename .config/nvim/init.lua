local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not (vim.uv or vim.loop).fs_stat(lazypath) then
  vim.fn.system({
    "git",
    "clone",
    "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable",
    lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)
require("mappings")
require("lazy").setup("plugins", {
  -- defaults = { lazy = true },
  -- checker = { enabled = true },
  -- ui = { border = "rounded" },
  -- performance = {
  -- 	cache = {
  -- 		enabled = true,
  -- 	},
  -- 	rtp = {
  -- 		disabled_plugins = {
  -- 			"netrwPlugin",
  -- 			"gzip",
  -- 			"tarPlugin",
  -- 			"tohtml",
  -- 			"tutor",
  -- 			"zipPlugin",
  -- 		},
  -- 	},
  -- },
  debug = false,
})
