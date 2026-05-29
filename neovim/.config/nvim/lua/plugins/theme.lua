local in_ssh = vim.env.SSH_CONNECTION ~= nil or vim.env.SSH_TTY ~= nil

if not in_ssh then
  local omarchy_theme_path = "/home/miguel/.config/omarchy/current/theme/neovim.lua"
  local stat = vim.loop.fs_stat(omarchy_theme_path)
  if stat then
    return dofile(omarchy_theme_path)
  end
end

-- Detect macOS system appearance
local function is_dark_mode()
  local handle = io.popen("defaults read -g AppleInterfaceStyle 2>/dev/null")
  if handle then
    local result = handle:read("*a")
    handle:close()
    return result:match("Dark") ~= nil
  end
  return true -- Default to dark if detection fails
end

local flavour = in_ssh and "mocha" or (is_dark_mode() and "macchiato" or "latte")

return {
  -- Configure catppuccin theme
  {
    "catppuccin/nvim",
    name = "catppuccin",
    lazy = false,
    priority = 1000,
    config = function()
      require("catppuccin").setup({
        flavour = flavour,
      })
      vim.cmd("colorscheme catppuccin")
    end,
  },

  -- Configure LazyVim to load catppuccin
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = "catppuccin",
    },
  },

  -- You can add other themes here and switch between them
  -- Example: gruvbox theme (commented out)
  -- { "ellisonleao/gruvbox.nvim" },

  -- Example: rose-pine theme (commented out)
  -- {
  --   "rose-pine/neovim",
  --   name = "rose-pine",
  --   lazy = false,
  --   priority = 1000,
  -- },
}
