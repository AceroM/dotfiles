return {
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        lua_ls = {
          -- nvim 0.11 native LSP: root_dir is (bufnr, on_dir); call on_dir(root)
          -- to start the server. Skip when root resolves to $HOME so lua_ls
          -- doesn't load with the home dir as workspace.
          root_dir = function(bufnr, on_dir)
            local root = vim.fs.root(bufnr, {
              ".luarc.json",
              ".luarc.jsonc",
              ".stylua.toml",
              "stylua.toml",
              ".git",
            })
            if root and root ~= vim.loop.os_homedir() then
              on_dir(root)
            end
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
          -- Start Prisma LS only in real project roots (schema.prisma, a
          -- prisma/ dir, or a git repo), and never with $HOME as the root.
          root_dir = function(bufnr, on_dir)
            local root = vim.fs.root(bufnr, {
              "schema.prisma",
              "prisma",
              ".git",
            })
            if root and root ~= vim.loop.os_homedir() then
              on_dir(root)
            end
          end,
        },
      },
    },
  },
}
