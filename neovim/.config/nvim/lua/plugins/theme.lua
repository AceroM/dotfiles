local in_ssh = vim.env.SSH_CONNECTION ~= nil or vim.env.SSH_TTY ~= nil

if not in_ssh then
  local omarchy_theme_path = "/home/miguel/.config/omarchy/current/theme/neovim.lua"
  local stat = vim.loop.fs_stat(omarchy_theme_path)
  if stat then
    return dofile(omarchy_theme_path)
  end
end

return {
  -- Follow the terminal's background. Neovim 0.10+ queries the terminal
  -- (OSC 11) on startup and sets `vim.o.background` to "dark"/"light".
  -- rose-pine's `variant = "auto"` then uses `dark_variant` (main) when the
  -- terminal is dark and "dawn" when it's light. Neovim defaults `background`
  -- to "dark", so an undetectable terminal falls back to the dark variant.
  -- (The terminal's response lands after startup, so `config/autocmds.lua`
  -- re-applies the colorscheme on `OptionSet background` to keep this in sync.)
  {
    "rose-pine/neovim",
    name = "rose-pine",
    lazy = false,
    priority = 1000,
    opts = {
      variant = "auto",
      dark_variant = "main", -- "main" or "moon" for the dark flavor
    },
    config = function(_, opts)
      require("rose-pine").setup(opts)
    end,
  },

  -- Tell LazyVim to use rose-pine
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = "rose-pine",
    },
  },
}
