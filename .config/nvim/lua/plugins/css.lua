return {
  "jsongerber/nvim-px-to-rem",
  config = function()
    require("nvim-px-to-rem").setup()
    vim.keymap.set("i", "<C-r>", "<cmd>PxToRemLine<cr>")
  end,
}
