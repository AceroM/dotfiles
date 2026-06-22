-- diffview.nvim — 3-way merge conflict resolution + diff/file-history viewer.
-- For merges/rebases with conflicts, `:DiffviewOpen` lists the conflicted files;
-- opening one shows the merge tool: OURS (left) | RESULT (middle) | THEIRS (right).
return {
  "sindrets/diffview.nvim",
  cmd = {
    "DiffviewOpen",
    "DiffviewClose",
    "DiffviewToggleFiles",
    "DiffviewFocusFiles",
    "DiffviewFileHistory",
  },
  opts = {
    enhanced_diff_hl = true,
    -- Start with the left file panel (the sidebar) collapsed. Toggle it back
    -- with <leader>b; <tab>/<s-tab> cycle files even while it's closed.
    hooks = {
      view_opened = function(view)
        vim.schedule(function()
          if view.panel and view.panel:is_open() then
            view.panel:close()
          end
        end)
      end,
    },
    view = {
      -- Three-panel merge layout: OURS | working/result | THEIRS, side by side.
      -- Cycle layouts live with `g<C-x>` (e.g. to `diff3_mixed`, which stacks
      -- OURS/THEIRS on top and the result full-width below).
      merge_tool = {
        layout = "diff3_horizontal",
        disable_diagnostics = true, -- conflict markers spam the LSP otherwise
      },
    },
  },
  keys = {
    { "<leader>gd", "<cmd>DiffviewOpen<cr>", desc = "Diffview: open (merge/diff)" },
    { "<leader>gD", "<cmd>DiffviewClose<cr>", desc = "Diffview: close" },
    { "<leader>gV", "<cmd>DiffviewFileHistory %<cr>", desc = "Diffview: file history" },
  },
}
