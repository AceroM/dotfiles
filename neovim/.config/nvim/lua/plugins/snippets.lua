return {
  "L3MON4D3/LuaSnip",
  version = "v2.*",
  build = "make install_jsregexp",
  dependencies = {
    "rafamadriz/friendly-snippets",
  },
  config = function()
    local ls = require("luasnip")
    local types = require("luasnip.util.types")

    ls.config.set_config({
      history = true,
      updateevents = "TextChanged,TextChangedI",
      enable_autosnippets = true,
      ext_opts = {
        [types.choiceNode] = {
          active = {
            virt_text = { { "●", "DiagnosticWarn" } },
          },
        },
      },
    })

    -- require("luasnip.loaders.from_vscode").lazy_load()
    require("luasnip.loaders.from_lua").lazy_load({ paths = { "./lua/snippets" } })

    -- Load snippets only for JS/TS filetypes
    local js_ts_filetypes = { "javascript", "typescript", "javascriptreact", "typescriptreact" }

    local init_snippets = require("snippets.init")
    local all_snippets = require("snippets.all")

    for _, ft in ipairs(js_ts_filetypes) do
      ls.add_snippets(ft, init_snippets, {
        autotrigger = true,
        type = "autosnippets",
        key = "init",
        priority = 9999,
      })
      ls.add_snippets(ft, all_snippets, {
        autotrigger = true,
        type = "autosnippets",
        key = "all",
        priority = 9999,
      })
    end

    vim.keymap.set({ "i" }, "<C-K>", function()
      ls.expand({})
    end, { silent = true })
    vim.keymap.set({ "i", "s" }, "<C-L>", function()
      ls.jump(1)
    end, { silent = true })
    vim.keymap.set({ "i", "s" }, "<C-J>", function()
      ls.jump(-1)
    end, { silent = true })
    vim.keymap.set({ "i", "s" }, "<C-E>", function()
      if ls.choice_active() then
        ls.change_choice(1)
      end
    end, { silent = true })
  end,
}
