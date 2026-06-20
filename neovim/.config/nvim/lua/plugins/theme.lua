local in_ssh = vim.env.SSH_CONNECTION ~= nil or vim.env.SSH_TTY ~= nil

if not in_ssh then
  local omarchy_theme_path = "/home/miguel/.config/omarchy/current/theme/neovim.lua"
  local stat = vim.loop.fs_stat(omarchy_theme_path)
  if stat then
    return dofile(omarchy_theme_path)
  end
end

return {
  -- Configure rose-pine theme (dawn = light variant)
  {
    "rose-pine/neovim",
    name = "rose-pine",
    lazy = false,
    priority = 1000,
    config = function()
      require("rose-pine").setup({
        variant = "dawn", -- light. Use "main"/"moon" for dark, or "auto" to follow background
        dark_variant = "main",
      })
      vim.o.background = "light"
      vim.cmd("colorscheme rose-pine")
    end,
  },

  -- Tell LazyVim to use rose-pine
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = "rose-pine",
    },
  },

  -- You can switch back to catppuccin by setting colorscheme = "catppuccin" above.
}
