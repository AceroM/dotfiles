return {
  "folke/snacks.nvim",
  opts = function(_, opts)
    local keys = opts.dashboard.preset.keys

    -- "Git Diff" entry: opens the picker for the current diffs
    local diff_item = {
      icon = "󰊢 ",
      key = "d",
      desc = "Git Diff",
      action = function()
        Snacks.picker.git_diff()
      end,
    }

    -- Insert right after "Find Text" (key "g"); fall back to appending
    local pos = #keys + 1
    for i, item in ipairs(keys) do
      if item.key == "g" then
        pos = i + 1
        break
      end
    end
    table.insert(keys, pos, diff_item)
  end,
}
