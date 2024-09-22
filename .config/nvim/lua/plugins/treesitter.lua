return {
  "nvim-treesitter/nvim-treesitter",
  build = ":TSUpdate",
  -- lazy = false,
  event = "BufRead",
  config = function()
    local config = require("nvim-treesitter.configs")
    config.setup({
      auto_install = true,
      highlight = { enable = true },
      indent = { enable = true },
      ensure_installed = { "markdown", "markdown_inline" },
    })
  end,
}
