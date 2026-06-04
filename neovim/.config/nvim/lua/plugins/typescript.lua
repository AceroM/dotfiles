return {
  "neovim/nvim-lspconfig",
  opts = {
    inlayHints = { enabled = false },
    servers = {
      --- @deprecated -- tsserver renamed to ts_ls but not yet released, so keep this for now
      --- the proper approach is to check the nvim-lspconfig release version when it's released to determine the server name dynamically
      tsserver = {
        enabled = false,
      },
      ts_ls = {
        enabled = false,
      },
      vtsls = {
        settings = {
          typescript = {
            -- Cap tsserver's V8 heap (passed as --max-old-space-size, in MB).
            -- Default is 3072. At ~4096 heap the process RSS peaks around 5 GB,
            -- then tsserver OOM-crashes and the LSP client auto-restarts it.
            tsserver = {
              maxTsServerMemory = 4096,
            },
            inlayHints = {
              enabled = false,
            },
          },
          javascript = {
            inlayHints = {
              enabled = false,
            },
          },
        },
        keys = {
          {
            "<leader>co",
            LazyVim.lsp.action["source.organizeImports"],
            desc = "Organize Imports",
          },
          {
            "<leader>cM",
            LazyVim.lsp.action["source.addMissingImports.ts"],
            desc = "Add missing imports",
          },
          {
            "<leader>cu",
            LazyVim.lsp.action["source.removeUnused.ts"],
            desc = "Remove unused imports",
          },
          {
            "<leader>cD",
            LazyVim.lsp.action["source.fixAll.ts"],
            desc = "Fix all diagnostics",
          },
        },
      },
      tsgo = {
        enabled = false,
        settings = {
          typescript = {
            inlayHints = {
              enabled = false,
            },
          },
          javascript = {
            inlayHints = {
              enabled = false,
            },
          },
        },
        keys = {
          {
            "<leader>co",
            LazyVim.lsp.action["source.organizeImports"],
            desc = "Organize Imports",
          },
          {
            "<leader>cM",
            LazyVim.lsp.action["source.addMissingImports.ts"],
            desc = "Add missing imports",
          },
          {
            "<leader>cu",
            LazyVim.lsp.action["source.removeUnused.ts"],
            desc = "Remove unused imports",
          },
          {
            "<leader>cD",
            LazyVim.lsp.action["source.fixAll.ts"],
            desc = "Fix all diagnostics",
          },
        },
      },
    },
    setup = {
      --- @deprecated -- tsserver renamed to ts_ls but not yet released, so keep this for now
      --- the proper approach is to check the nvim-lspconfig release version when it's released to determine the server name dynamically
      tsserver = function()
        -- disable tsserver
        return true
      end,
      ts_ls = function()
        -- disable tsserver
        return true
      end,
      vtsls = function()
        return false
      end,
    },
  },
}
