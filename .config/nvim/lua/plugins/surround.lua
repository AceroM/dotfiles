return {
  "echasnovski/mini.nvim",
  lazy = false,
  version = false,
  config = function()
    require("mini.surround").setup()
  end,
}
