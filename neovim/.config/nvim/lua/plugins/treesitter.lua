return {
  "nvim-treesitter/nvim-treesitter",
  opts = {
    ensure_installed = { "prisma" },
    incremental_selection = {
      enable = true,
      keymaps = {
        init_selection = "<c-l>",
        scope_incremental = "<c-l>",
        -- `v` grows the selection to the next treesitter node, so holding down
        -- `vvvv…` walks char → identifier → expression → statement → block. The
        -- first `v` is still vanilla vim (enter charwise visual); every one after
        -- expands, since node_incremental seeds itself from the live selection
        -- when it wasn't started via init_selection.
        --
        -- These are buffer-local (treesitter attaches them per buffer), so a
        -- buffer with no parser keeps the built-in `v`. Where a parser *is*
        -- attached, the built-in visual-mode `v` (switch to / exit charwise
        -- visual) is gone — leave visual with <Esc>.
        node_incremental = "v",
        node_decremental = "<S-TAB>",
      },
    },
  },
  -- <TAB> still increments too; the keymaps table above only takes one key per
  -- function, so the second one is mapped here. Safe to set globally: <Tab> has
  -- no visual-mode default, and node_incremental is a no-op without a parser.
  keys = {
    {
      "<TAB>",
      function()
        pcall(function()
          require("nvim-treesitter.incremental_selection").node_incremental()
        end)
      end,
      mode = "x",
      desc = "Increment selection",
    },
  },
}
