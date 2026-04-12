return {
  -- Configure conform.nvim formatters
  {
    "stevearc/conform.nvim",
    opts = function(_, opts)
      opts.formatters_by_ft = opts.formatters_by_ft or {}

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

      opts.formatters_by_ft.sh = { "shfmt" }
      opts.formatters_by_ft.bash = { "shfmt" }
      opts.formatters_by_ft.zsh = {}

      return opts
    end,
  },
}
