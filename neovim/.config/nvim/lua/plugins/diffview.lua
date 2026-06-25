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
  -- opts is a function so we can require("diffview.actions") only when the plugin
  -- actually loads (keeps the cmd-based lazy-loading intact).
  opts = function(_, opts)
    local actions = require("diffview.actions")

    opts.enhanced_diff_hl = true
    opts.view = {
      -- Three-panel merge layout: OURS | working/result | THEIRS, side by side.
      -- Cycle layouts live with `g<C-x>` (e.g. to `diff3_mixed`, which stacks
      -- OURS/THEIRS on top and the result full-width below).
      merge_tool = {
        layout = "diff3_horizontal",
        disable_diagnostics = true, -- conflict markers spam the LSP otherwise
      },
    }
    -- <c-d>/<c-u> from the file panel scroll the *diff content*, never the
    -- sidebar buffer. scroll_view always targets the diff window regardless of
    -- where the cursor is. These merge with diffview's defaults (which already
    -- map <c-b>/<c-f> the same way).
    -- <A-Down>/<A-Up> (Option+Down/Up on macOS) mirror <c-d>/<c-u> here too. The
    -- global keymaps.lua remaps Option-arrows -> <C-d>/<C-u> (noremap), which in
    -- this panel would hit the *built-in* scroll and move the sidebar buffer.
    -- A buffer-local map for the Option-arrows overrides that and scrolls the diff.
    local scroll_down = actions.scroll_view(0.5)
    local scroll_up = actions.scroll_view(-0.5)
    local scroll_maps = {
      { "n", "<c-d>", scroll_down, { desc = "Scroll the diff down" } },
      { "n", "<c-u>", scroll_up, { desc = "Scroll the diff up" } },
      { "n", "<A-Down>", scroll_down, { desc = "Scroll the diff down" } },
      { "n", "<A-Up>", scroll_up, { desc = "Scroll the diff up" } },
    }
    opts.keymaps = {
      file_panel = scroll_maps,
      file_history_panel = scroll_maps,
    }
  end,
  keys = {
    { "<leader>gd", "<cmd>DiffviewOpen<cr>", desc = "Diffview: open (merge/diff)" },
    { "<leader>gD", "<cmd>DiffviewClose<cr>", desc = "Diffview: close" },
    { "<leader>gV", "<cmd>DiffviewFileHistory %<cr>", desc = "Diffview: file history" },
  },
}
