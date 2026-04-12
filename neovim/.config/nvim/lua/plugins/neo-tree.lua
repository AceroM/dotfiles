return {
  "nvim-neo-tree/neo-tree.nvim",
  opts = {
    filesystem = {
      filtered_items = {
        hide_dotfiles = false,
        hide_hidden = false,
      },
    },
    window = {
      position = "left",
      width = 30, -- You can adjust this to your preference
      mappings = {
        ["<space>"] = "none",
        ["zz"] = function()
          vim.cmd("normal! zz")
        end,
        ["zt"] = function()
          vim.cmd("normal! zt")
        end,
        ["zb"] = function()
          vim.cmd("normal! zb")
        end,
      },
    },
    default_component_configs = {
      indent = {
        with_expanders = true,
        expander_collapsed = "",
        expander_expanded = "",
        expander_highlight = "NeoTreeExpander",
      },
    },
    renderers = {
      directory = {
        { "indent" },
        { "icon" },
        { "current_filter" },
        { "name", use_git_status_colors = true },
        { "diagnostics" },
        { "git_status", highlight = "NeoTreeDimText" },
      },
      file = {
        { "indent" },
        { "icon" },
        { "name", use_git_status_colors = true },
        { "diagnostics" },
        { "git_status", highlight = "NeoTreeDimText" },
      },
    },
    -- Enable line numbers
    popup_border_style = "rounded",
    enable_git_status = true,
    enable_diagnostics = true,
    -- This will show line numbers in the neo-tree buffer
    event_handlers = {
      {
        event = "neo_tree_buffer_enter",
        handler = function()
          vim.cmd("setlocal relativenumber")
        end,
      },
    },
  },
}
