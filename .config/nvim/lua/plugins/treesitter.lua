return {
	"nvim-treesitter/nvim-treesitter",
	build = ":TSUpdate",
	event = "BufRead",
	dependencies = {
		"nvim-treesitter/nvim-treesitter-textobjects",
		"tree-sitter/tree-sitter-embedded-template",
	},
	config = function()
		local config = require("nvim-treesitter.configs")
		config.setup({
			auto_install = true,
			indent = { enable = true },
			autopairs = {
				enable = true,
			},
			highlight = {
				enable = true,
				-- Disable slow treesitter highlight for large files
				disable = function(lang, buf)
					local max_filesize = 100 * 1024 -- 100 KB
					local ok, stats = pcall(vim.loop.fs_stat, vim.api.nvim_buf_get_name(buf))
					if ok and stats and stats.size > max_filesize then
						return true
					end
				end,
				-- Setting this to true will run `:h syntax` and tree-sitter at the same time.
				-- Set this to `true` if you depend on 'syntax' being enabled (like for indentation).
				-- Using this option may slow down your editor, and you may see some duplicate highlights.
				-- Instead of true it can also be a list of languages
				additional_vim_regex_highlighting = false,
			},
			ensure_installed = { "markdown", "markdown_inline", "ruby", "mermaid" },
			textobjects = {
				select = {
					enable = true,
					lookahead = true,
					keymaps = {
						["aa"] = "@parameter.outer",
						["ia"] = "@parameter.inner",
						["af"] = "@function.outer",
						["if"] = "@function.inner",
						["ac"] = "@class.outer",
						["ic"] = "@class.inner",
						["iB"] = "@block.inner",
						["aB"] = "@block.outer",
					},
				},
				move = {
					enable = true,
					set_jumps = true,
					goto_next_start = {
						["]]"] = "@function.outer",
					},
					goto_next_end = {
						["]["] = "@function.outer",
					},
					goto_previous_start = {
						["[["] = "@function.outer",
					},
					goto_previous_end = {
						["[]"] = "@function.outer",
					},
				},
			},
		})
	end,
}
