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

    -- Filetypes that get no general-purpose snippets. Keep in sync with the
    -- blink.cmp `enabled` gate in plugins/completion.lua. The small "universal"
    -- set remains available even here for explicitly global snippets.
    local no_snippets = { text = true, [""] = true }

    ls.config.set_config({
      history = true,
      updateevents = "TextChanged,TextChangedI",
      enable_autosnippets = true,
      -- snippets/all.lua is registered under the "global" pseudo-filetype so it
      -- applies everywhere. It can't use LuaSnip's real "all" filetype: LuaSnip
      -- appends "all" to ft_func()'s result unconditionally, so there would be
      -- no way to opt a buffer back out of it.
      ft_func = function()
        local filetypes = { "universal" }
        if no_snippets[vim.bo.filetype] then
          return filetypes
        end
        vim.list_extend(filetypes, { vim.bo.filetype, "global" })
        return filetypes
      end,
      ext_opts = {
        [types.choiceNode] = {
          active = {
            virt_text = { { "●", "DiagnosticWarn" } },
          },
        },
      },
    })

    -- require("luasnip.loaders.from_vscode").lazy_load()

    -- One add_snippets() call per key. Calling it repeatedly with the same key
    -- invalidates the previous call's snippets, and because every filetype was
    -- handed the same snippet objects that used to wipe out all of them.
    -- Extra filetypes are wired up with filetype_extend instead.
    ls.add_snippets("universal", require("snippets.universal"), { type = "autosnippets", key = "snippets_universal" })
    ls.add_snippets("global", require("snippets.all"), { type = "autosnippets", key = "snippets_all" })
    ls.add_snippets("javascript", require("snippets.init"), { type = "autosnippets", key = "snippets_init" })

    for _, ft in ipairs({ "typescript", "javascriptreact", "typescriptreact" }) do
      ls.filetype_extend(ft, { "javascript" })
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
