-- Over SSH, transparency lets the remote terminal's background bleed through
-- and the theme's palette stops reading correctly. Bail and let the theme paint.
if vim.env.SSH_CONNECTION or vim.env.SSH_TTY then
  return
end

local groups = {
  -- transparent background
  "Normal",
  "NormalFloat",
  "FloatBorder",
  "Pmenu",
  "Terminal",
  "EndOfBuffer",
  "FoldColumn",
  "Folded",
  "SignColumn",
  "NormalNC",
  "WhichKeyFloat",
  "TelescopeBorder",
  "TelescopeNormal",
  "TelescopePromptBorder",
  "TelescopePromptTitle",

  -- transparent background for neotree
  "NeoTreeNormal",
  "NeoTreeNormalNC",
  "NeoTreeVertSplit",
  "NeoTreeWinSeparator",
  "NeoTreeEndOfBuffer",

  -- transparent background for nvim-tree
  "NvimTreeNormal",
  "NvimTreeVertSplit",
  "NvimTreeEndOfBuffer",

  -- transparent notify background
  "NotifyINFOBody",
  "NotifyERRORBody",
  "NotifyWARNBody",
  "NotifyTRACEBody",
  "NotifyDEBUGBody",
  "NotifyINFOTitle",
  "NotifyERRORTitle",
  "NotifyWARNTitle",
  "NotifyTRACETitle",
  "NotifyDEBUGTitle",
  "NotifyINFOBorder",
  "NotifyERRORBorder",
  "NotifyWARNBorder",
  "NotifyTRACEBorder",
  "NotifyDEBUGBorder",
}

local function apply_transparency()
  for _, group in ipairs(groups) do
    vim.api.nvim_set_hl(0, group, { bg = "none" })
  end
end

-- Re-apply after every colorscheme load. `colorscheme` clears highlights, and we
-- re-apply it whenever the terminal's background changes (see config/autocmds.lua),
-- so transparency has to be reasserted each time rather than set once at startup.
vim.api.nvim_create_autocmd("ColorScheme", {
  callback = apply_transparency,
})

apply_transparency()
