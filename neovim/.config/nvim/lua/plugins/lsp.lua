return {
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        lua_ls = {
          -- Avoid lua_ls loading with $HOME as root
          root_dir = function(fname)
            local util = require("lspconfig.util")
            local root = util.root_pattern(
              ".luarc.json",
              ".luarc.jsonc",
              ".stylua.toml",
              "stylua.toml",
              ".git"
            )(fname)
            local home = vim.loop.os_homedir()
            if root == home then
              return nil
            end
            return root
          end,
          settings = {
            Lua = {
              workspace = { checkThirdParty = false },
              telemetry = { enable = false },
              hint = { enable = true },
              diagnostics = { globals = { "vim" } },
            },
          },
        },
        prismals = {
          -- Start Prisma LS only in real project roots
          root_dir = function(fname)
            local util = require("lspconfig.util")
            local root = util.root_pattern(
              -- common locations of the Prisma schema
              "schema.prisma",
              "prisma/schema.prisma",
              ".git"
            )(fname)
            local home = vim.loop.os_homedir()
            if root == home then
              return nil
            end
            return root
          end,
          -- Avoid starting for loose single files without a project
          single_file_support = false,
        },
      },
    },
  },
}
