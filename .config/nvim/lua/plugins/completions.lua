return {
	{
		"hrsh7th/cmp-nvim-lsp",
	},
	{
		"windwp/nvim-autopairs",
		event = "InsertEnter",
		config = true,
	},
	{
		"L3MON4D3/LuaSnip",
		event = "InsertEnter",
		dependencies = { "saadparwaiz1/cmp_luasnip" },
		config = function()
			local ls = require("luasnip")
			vim.keymap.set({ "i" }, "<C-K>", function()
				ls.expand()
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
			ls.config.setup({ enable_autosnippets = true })
			local tailwind_snippets = require("plugins.luasnip.tailwind")
			local astro_snippets = require("plugins.luasnip.astro")
			local css_snippets = require("plugins.luasnip.css")
			local ruby_snippets = require("plugins.luasnip.ruby")
			local eruby_snippets = require("plugins.luasnip.eruby")
			local sql_snippets = require("plugins.luasnip.sql")
			local html_snippets = require("plugins.luasnip.html")
			local shadcn_snippets = require("plugins.luasnip.shadcn")
			local js_snippets = require("plugins.luasnip.js")
			local all_snippets = require("plugins.luasnip.all")
			local lua_snippets = require("plugins.luasnip.lua")
			ls.add_snippets("all", all_snippets, {
				autotrigger = true,
				type = "autosnippets",
				key = "all",
				priority = 9999,
			})
			ls.add_snippets("lua", lua_snippets, {
				autotrigger = true,
				type = "autosnippets",
				key = "lua",
				priority = 9999,
			})
			for _, filetype in ipairs({ "javascriptreact", "typescriptreact", "javascript", "typescript" }) do
				ls.add_snippets(filetype, js_snippets, {
					autotrigger = true,
					type = "autosnippets",
					key = filetype,
					priority = 9999,
				})
				ls.add_snippets(filetype, shadcn_snippets, {
					autotrigger = true,
					type = "autosnippets",
					key = filetype .. "_shadcn",
					priority = 9999,
				})
			end
			ls.add_snippets("astro", astro_snippets, {
				autotrigger = true,
				type = "autosnippets",
				key = "astro",
				priority = 9999,
			})
			for _, filetype in ipairs({
				"javascriptreact",
				"typescriptreact",
				"javascript",
				"typescript",
				"ruby",
				"eruby",
				"astro",
			}) do
				ls.add_snippets(filetype, tailwind_snippets, {
					autotrigger = true,
					type = "autosnippets",
					key = filetype .. "_tailwind",
					priority = 9999,
				})
				ls.add_snippets(filetype, html_snippets, {
					autotrigger = true,
					type = "autosnippets",
					key = filetype .. "_html",
					priority = 9999,
				})
			end
			ls.add_snippets("html", html_snippets, {
				autotrigger = true,
				type = "autosnippets",
				key = "html",
				priority = 9999,
			})
			ls.add_snippets("css", css_snippets, {
				autotrigger = true,
				type = "autosnippets",
				key = "css",
				priority = 9999,
			})
			ls.add_snippets("ruby", ruby_snippets, {
				autotrigger = true,
				type = "autosnippets",
				key = "ruby",
				priority = 9999,
			})
			ls.add_snippets("eruby", eruby_snippets, {
				autotrigger = true,
				type = "autosnippets",
				key = "eruby",
				priority = 9999,
			})
			ls.add_snippets("sql", sql_snippets, {
				autotrigger = true,
				type = "autosnippets",
				key = "sql",
				priority = 9999,
			})
		end,
	},
	{
		"hrsh7th/nvim-cmp",
		event = "InsertEnter",
		config = function()
			local cmp = require("cmp")
			require("luasnip.loaders.from_vscode").lazy_load()
			cmp.setup({
				snippet = {
					expand = function(args)
						require("luasnip").lsp_expand(args.body)
					end,
				},
				window = {
					completion = cmp.config.window.bordered(),
					documentation = cmp.config.window.bordered(),
				},
				mapping = cmp.mapping.preset.insert({
					["<C-b>"] = cmp.mapping.scroll_docs(-4),
					["<C-f>"] = cmp.mapping.scroll_docs(4),
					["<C-Space>"] = cmp.mapping.complete(),
					["<C-e>"] = cmp.mapping.abort(),
					["<CR>"] = cmp.mapping.confirm({ select = true }),
				}),
				sources = cmp.config.sources({
					{ name = "nvim_lsp" },
					{ name = "luasnip" },
				}, {
					{ name = "buffer" },
				}),
			})
			local function enter_or_indent_tag()
				local line = vim.fn.getline(".")
				local col = vim.fn.col(".")
				local before = line:sub(col - 1, col - 1)
				local after = line:sub(col, col)
				if before == ">" and after == "<" then
					return "<CR><C-o>O"
				end
				return "<CR>"
			end
			vim.api.nvim_create_autocmd("FileType", {
				pattern = "eruby",
				callback = function()
					vim.keymap.set("i", "<CR>", enter_or_indent_tag, { buffer = true, expr = true })
				end,
			})
		end,
	},
}
