return {
  "nvim-neo-tree/neo-tree.nvim",
  branch = "v3.x",
  dependencies = {
    "nvim-lua/plenary.nvim",
    "nvim-tree/nvim-web-devicons",
    "MunifTanjim/nui.nvim",
  },
  keys = {
    { "<C-n>", "<Cmd>Neotree toggle<CR>" },
  },
  config = function()
    require("neo-tree").setup({
      auto_expand_width = true,
      position = "float",
      event_handlers = {
        {
          event = "file_opened",
          handler = function()
            require("neo-tree.command").execute({ action = "focus" })
          end,
        },
        {
          event = "neo_tree_buffer_enter",
          handler = function()
            vim.opt_local.relativenumber = true
            vim.cmd("set rnu")
          end,
        },
      },
      filesystem = {
        follow_current_file = true,
        use_libuv_file_watcher = true,
        cwd_target = {
          sidebar = "tab",
          current = "window",
        },
        window = {
          mappings = {
            ["o"] = "system_open",
          },
        },
      },
      commands = {
        system_open = function(state)
          local node = state.tree:get_node()
          local path = node:get_id()
          vim.fn.jobstart({ "xdg-open", path }, { detach = true })
          local p
          local lastSlashIndex = path:match("^.+()\\[^\\]*$") -- Match the last slash and everything before it
          if lastSlashIndex then
            p = path:sub(1, lastSlashIndex - 1)          -- Extract substring before the last slash
          else
            p = path                                     -- If no slash found, return original path
          end
          vim.cmd("silent !start explorer " .. p)
        end,
      },
    })
  end,
}
