return {
  "folke/which-key.nvim",
  opts = {
    -- Keep which-key where its menus are useful without intercepting motion
    -- prefixes such as g and z. This leaves gg, gv, gcc, zz, etc. entirely to
    -- Neovim while retaining discovery for leader and window commands.
    triggers = {
      { "<leader>", mode = { "n", "v" } },
      { "<localleader>", mode = { "n", "v" } },
      { "<c-w>", mode = "n" },
    },
  },
}
