return {
	{
		"yetone/avante.nvim",
		event = "VeryLazy",
		build = "make BUILD_FROM_SOURCE=true luajit",
		opts = {
			---@alias Provider "openai" | "claude" | "azure" | "deepseek" | "groq" | "copilot" | [string]
			provider = "claude",
			claude = {
				endpoint = "https://api.anthropic.com",
				model = "claude-3-5-sonnet-20240620",
				temperature = 0,
				max_tokens = 4096,
			},
			behaviour = {
				auto_suggestions = false, -- Experimental stage
				auto_set_highlight_group = true,
				auto_set_keymaps = true,
				auto_apply_diff_after_generation = false,
				support_paste_from_clipboard = false,
			},
			mappings = {
				ask = "<leader>aa",
				edit = "<leader>ae",
				refresh = "<leader>ar",
				--- @class AvanteConflictMappings
				diff = {
					ours = "co",
					theirs = "ct",
					none = "c0",
					both = "cb",
					next = "]x",
					prev = "[x",
				},
				jump = {
					next = "]]",
					prev = "[[",
				},
			},
			hints = { enabled = true },
			windows = {
				wrap = true, -- similar to vim.o.wrap
				width = 30, -- default % based on available width
				sidebar_header = {
					align = "center", -- left, center, right for title
					rounded = true,
				},
			},
			highlights = {
				---@type AvanteConflictHighlights
				diff = {
					current = "DiffText",
					incoming = "DiffAdd",
				},
			},
			--- @class AvanteConflictUserConfig
			diff = {
				debug = false,
				autojump = true,
				---@type string | fun(): any
				list_opener = "copen",
			},
		},
		dependencies = {
			"nvim-tree/nvim-web-devicons",
			"stevearc/dressing.nvim",
			"nvim-lua/plenary.nvim",
			"MunifTanjim/nui.nvim",
			--- The below is optional, make sure to setup it properly if you have lazy=true
			{
				"MeanderingProgrammer/render-markdown.nvim",
				opts = {
					file_types = { "markdown", "Avante" },
				},
				ft = { "markdown", "Avante" },
			},
		},
		config = function()
			require("avante_lib").load() -- note requiring avante_lib here
			require("avante").setup({
				-- add any options here if needed
			})
		end,
	},
	{
		"pasky/claude.vim",
		lazy = false,
		config = function()
			vim.g.claude_api_key = os.getenv("CLAUDE_API_KEY")
			vim.g.claude_map_implement = "<Leader>ci"
			vim.g.claude_map_open_chat = "<Leader>cc"
			vim.g.claude_map_send_chat_message = "<C-]>"
			vim.g.claude_map_cancel_response = "<Leader>cx"
		end,
	},
}
