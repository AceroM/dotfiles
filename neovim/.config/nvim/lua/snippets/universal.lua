local ls = require("luasnip")
local s = ls.snippet
local t = ls.text_node
local i = ls.insert_node
local events = require("luasnip.util.events")

return {
  s(
    {
      trig = "`;",
      name = "Fenced code block",
      dscr = "Triple-backtick block with the cursor inside",
      wordTrig = false,
    },
    {
      t({ "```", "" }),
      i(0),
      t({ "", "```" }),
    },
    {
      callbacks = {
        [-1] = {
          -- nvim-autopairs inserts a matching backtick after the first
          -- character of the trigger. Consume that generated character before
          -- expanding so the closing fence has exactly three backticks.
          [events.pre_expand] = function(_, event_args)
            local row, col = unpack(event_args.expand_pos)
            local next_char = vim.api.nvim_buf_get_text(0, row, col, row, col + 1, {})[1]
            if next_char == "`" then
              vim.api.nvim_buf_set_text(0, row, col, row, col + 1, {})
            end
          end,
        },
      },
    }
  ),
}
