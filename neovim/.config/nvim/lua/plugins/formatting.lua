return {
  -- Configure conform.nvim for formatting with prettierd
  {
    "stevearc/conform.nvim",
    opts = function(_, opts)
      -- Override formatters for specific file types to use prettierd

      opts.formatters_by_ft = opts.formatters_by_ft or {}
      -- Use prettierd for these file types
      local prettierd_filetypes = {
        "javascript",
        "javascriptreact",
        "typescript",
        "typescriptreact",
        "json",
        "jsonc",
        "html",
        "css",
        "scss",
        "markdown",
        "yaml",
      }

      for _, ft in ipairs(prettierd_filetypes) do
        opts.formatters_by_ft[ft] = { "prettierd" }
      end

      -- Enable format on save
      -- opts.format_on_save = {
      --   timeout_ms = 3000,
      --   lsp_fallback = true,
      -- }

      return opts
    end,
  },
}
