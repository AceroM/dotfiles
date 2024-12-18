return {
	{
		"stevearc/oil.nvim",
		lazy = false,
		dependencies = { "nvim-tree/nvim-web-devicons" },
		config = function()
			require("oil").setup({
				columns = { "icon" },
				skip_confirm_for_simple_edits = true,
				prompt_save_on_select_new_entry = false,
				view_options = {
					show_hidden = true,
				},
				keymaps = {
					["yp"] = {
						desc = "Copy file to system clipboard",
						callback = function()
							local entry = require("oil.actions").get_cursor_entry()
							if entry then
								local full_path = vim.fn.fnamemodify(entry.name, ":p")
								-- Use osascript on macOS to copy the file to clipboard
								vim.fn.system({
									"osascript",
									"-e",
									string.format(
										[[
                        set p to POSIX file "%s"
                        tell app "Finder" to set the clipboard to p
                    ]],
										full_path
									),
								})
							end
						end,
					},
				},
			})
			vim.keymap.set("n", ",", "<CMD>Oil<CR>", { desc = "Open parent directory" })
		end,
	},
}
