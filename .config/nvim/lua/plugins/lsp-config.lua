return {
	{
		"williamboman/mason.nvim",
		config = function()
			require("mason").setup()
		end,
	},
	{
		"williamboman/mason-lspconfig.nvim",
		config = function()
			require("mason-lspconfig").setup({
				ensure_installed = {
					"ruby_lsp",
					"html",
					"cssls",
					"lua_ls",
					"ts_ls",
					"emmet_language_server",
				},
			})
		end,
	},
	{
		"neovim/nvim-lspconfig",
		dependencies = {
			"jose-elias-alvarez/typescript.nvim",
			init = function() end,
		},
		config = function()
			local function add_ruby_deps_command(client, bufnr)
				vim.api.nvim_buf_create_user_command(bufnr, "ShowRubyDeps", function(opts)
					local params = vim.lsp.util.make_text_document_params()
					local showAll = opts.args == "all"
					client.request("rubyLsp/workspace/dependencies", params, function(error, result)
						if error then
							print("Error showing deps: " .. error)
							return
						end
						local qf_list = {}
						for _, item in ipairs(result) do
							if showAll or item.dependency then
								table.insert(qf_list, {
									text = string.format("%s (%s) - %s", item.name, item.version, item.dependency),
									filename = item.path,
								})
							end
						end
						vim.fn.setqflist(qf_list)
						vim.cmd("copen")
					end, bufnr)
				end, {
					nargs = "?",
					complete = function()
						return { "all" }
					end,
				})
			end
			local capabilities = require("cmp_nvim_lsp").default_capabilities()
			capabilities.textDocument.foldingRange = {
				dynamicRegistration = false,
				lineFoldingOnly = true,
			}
			local lspconfig = require("lspconfig")
			require("lspconfig").cssls.setup({
				capabilities = capabilities,
				settings = {
					css = {
						lint = {
							unknownAtRules = "ignore",
							emptyRules = "ignore",
						},
					},
				},
			})
			lspconfig.lua_ls.setup({ capabilities = capabilities })
			lspconfig.html.setup({ capabilities = capabilities })
			lspconfig.ruby_lsp.setup({
				capabilities = capabilities,
				on_attach = function(client, buffer)
					add_ruby_deps_command(client, buffer)
				end,
			})
			lspconfig.ts_ls.setup({
				filetypes = { "typescript", "typescriptreact", "javascript", "javascriptreact" },
				capabilities = capabilities,
				settings = {
					documentFormatting = true,
					diagnostics = {
						ignoredCodes = { 2786, 2769, 7044, 2698, 2367, 2705, 2802, 80001, 2554, 6133 },
					},
					typescript = {
						inlayHints = {
							includeInlayParameterNameHints = "literal",
							includeInlayParameterNameHintsWhenArgumentMatchesName = false,
							includeInlayFunctionParameterTypeHints = true,
							includeInlayVariableTypeHints = false,
							includeInlayPropertyDeclarationTypeHints = true,
							includeInlayFunctionLikeReturnTypeHints = true,
							includeInlayEnumMemberValueHints = true,
						},
					},
				},
			})
			local opts = { noremap = true, silent = true }
			vim.keymap.set("n", "gd", "<cmd>lua vim.lsp.buf.definition()<cr>", opts)
			vim.keymap.set("n", "gD", "<cmd>lua vim.lsp.buf.declaration()<cr>", opts)
			vim.keymap.set("n", "gi", "<cmd>lua vim.lsp.buf.implementation()<cr>", opts)
			vim.keymap.set("n", "go", "<cmd>lua vim.lsp.buf.type_definition()<cr>", opts)
			vim.keymap.set("n", "gr", "<cmd>lua vim.lsp.buf.references()<cr>", opts)
			vim.keymap.set("n", "gs", "<cmd>lua vim.lsp.buf.signature_help()<cr>", opts)
			vim.keymap.set("n", "[d", "<cmd>lua vim.diagnostic.goto_prev()<cr>", opts)
			vim.keymap.set("n", "]d", "<cmd>lua vim.diagnostic.goto_next()<cr>", opts)
			vim.keymap.set(
				"n",
				"<F15>",
				"<cmd>lua vim.diagnostic.goto_prev({severity = vim.diagnostic.severity.ERROR})<cr>",
				opts
			)
			vim.keymap.set(
				"n",
				"<F3>",
				"<cmd>lua vim.diagnostic.goto_next({severity = vim.diagnostic.severity.ERROR})<cr>",
				opts
			)
			vim.keymap.set("n", "K", vim.lsp.buf.hover, opts)
			vim.keymap.set({ "n", "v" }, "<leader>ca", vim.lsp.buf.code_action, opts)
			vim.keymap.set({ "n", "v" }, "<F4>", vim.lsp.buf.code_action, opts)
			vim.keymap.set({ "n", "v" }, "<a-cr>", vim.lsp.buf.code_action, opts)
			vim.keymap.set("n", "<space>wa", vim.lsp.buf.add_workspace_folder, opts)
			vim.keymap.set("n", "<space>wr", vim.lsp.buf.remove_workspace_folder, opts)
		end,
	},
}