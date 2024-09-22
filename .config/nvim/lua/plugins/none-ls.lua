return {
  "nvimtools/none-ls.nvim",
  lazy = false,
  dependencies = {
    "nvimtools/none-ls-extras.nvim",
  },
  config = function()
    local augroup = vim.api.nvim_create_augroup("LspFormatting", {})
    local null_ls = require("null-ls")
    local eslint = require("none-ls.diagnostics.eslint")
    null_ls.setup({
      sources = {
        eslint.with({
          condition = function(utils)
            return utils.root_has_file({ ".eslintrc.js", ".eslintrc.cjs", "eslint.config.js" })
          end,
        }),
        null_ls.builtins.formatting.rubocop,
        null_ls.builtins.formatting.stylua,
        null_ls.builtins.formatting.prettierd,
      },
      on_attach = function(client, bufnr)
        if client.supports_method("textDocument/formatting") then
          vim.api.nvim_clear_autocmds({ group = augroup, buffer = bufnr })
          vim.api.nvim_create_autocmd("BufWritePre", {
            group = augroup,
            buffer = bufnr,
            callback = function()
              vim.lsp.buf.format({ async = false, timeout = 50000 })
            end,
          })
        end
      end,
    })
    vim.keymap.set("n", "<F2>", function()
      vim.lsp.buf.rename()
    end, {})
    vim.keymap.set({ "n", "x" }, "F3", function()
      vim.lsp.buf.format({ timeout = 5000 })
      vim.cmd("w")
    end, {})
  end,
}
