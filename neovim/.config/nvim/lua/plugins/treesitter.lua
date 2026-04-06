return {
  "nvim-treesitter/nvim-treesitter",
  opts = {
    incremental_selection = {
      enable = true,
      keymaps = {
        init_selection = "<c-l>",
        scope_incremental = "<c-l>",
        node_incremental = "<TAB>",
        node_decremental = "<S-TAB>",
      },
    },
  },
}

