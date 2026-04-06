return {
  {
    "saghen/blink.cmp",
    opts = function(_, opts)
      -- Configure snippet provider to use LuaSnip
      opts.snippets = {
        preset = "luasnip",
      }
      
      -- Make sure luasnip is included in the sources
      opts.sources = opts.sources or {}
      opts.sources.default = opts.sources.default or { "lsp", "path", "snippets", "buffer" }
      
      -- Configure keymap for snippet navigation
      opts.keymap = opts.keymap or {}
      opts.keymap.preset = opts.keymap.preset or "default"
      opts.keymap["<C-k>"] = { "snippet_forward", "fallback" }
      opts.keymap["<C-j>"] = { "snippet_backward", "fallback" }
      
      -- Configure completion trigger behavior
      opts.completion = opts.completion or {}
      opts.completion.trigger = opts.completion.trigger or {}
      opts.completion.trigger.show_on_trigger_character = false
      opts.completion.trigger.show_on_keyword = true
      opts.completion.trigger.show_on_accept_on_trigger_character = false
      
      -- Reduce aggressive completion triggers
      opts.completion.trigger.show_on_insert_on_trigger_character = false
      
      return opts
    end,
  },
}
