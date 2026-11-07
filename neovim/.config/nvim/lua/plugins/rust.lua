return {
  {
    "mrcjkb/rustaceanvim",
    -- v9 requires Neovim 0.12; keep this setup compatible with Neovim 0.11.
    version = "^8",
    -- Pure Lua: use the pinned Git checkout, not a newer LuaRocks release.
    build = false,
    opts = {
      server = {
        default_settings = {
          ["rust-analyzer"] = {
            cargo = {
              -- Respect Cargo's default features: some crates have mutually
              -- exclusive features that fail with LazyVim's allFeatures=true.
              allFeatures = false,
              -- Keep editor checks from blocking terminal cargo builds.
              targetDir = true,
            },
            check = {
              command = "clippy",
              extraArgs = { "--no-deps" },
            },
          },
        },
      },
    },
    config = function(_, opts)
      opts.server.capabilities = require("blink.cmp").get_lsp_capabilities(opts.server.capabilities)
      -- Use Mason's configured root rather than the removed Package:get_install_path
      -- API, so this works with both Mason 1 and Mason 2.
      local package_path = require("mason.settings").current.install_root_dir .. "/packages/codelldb"
      local library = vim.fn.has("mac") == 1 and "liblldb.dylib" or "liblldb.so"
      opts.dap = {
        adapter = require("rustaceanvim.config").get_codelldb_adapter(
          package_path .. "/extension/adapter/codelldb",
          package_path .. "/extension/lldb/lib/" .. library
        ),
      }
      vim.g.rustaceanvim = vim.tbl_deep_extend("keep", vim.g.rustaceanvim or {}, opts)
    end,
    keys = {
      {
        "<leader>cr",
        function()
          vim.cmd.RustLsp("runnables")
        end,
        desc = "Rust Runnables",
        ft = "rust",
      },
      {
        "<leader>ct",
        function()
          vim.cmd.RustLsp("testables")
        end,
        desc = "Rust Tests",
        ft = "rust",
      },
      {
        "<leader>cm",
        function()
          vim.cmd.RustLsp("expandMacro")
        end,
        desc = "Expand Macro",
        ft = "rust",
      },
    },
  },
}
