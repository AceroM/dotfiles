return {
	"nvim-neo-tree/neo-tree.nvim",
	branch = "v3.x",
	dependencies = {
		"nvim-lua/plenary.nvim",
		"nvim-tree/nvim-web-devicons",
		"MunifTanjim/nui.nvim",
	},
	keys = {
		{ "<C-n>", "<Cmd>Neotree toggle<CR>" },
	},
	config = function()
		require("neo-tree").setup({
			window = {
				position = "left",
				width = 30,
			},
			event_handlers = {
				{
					event = "file_opened",
					handler = function()
						require("neo-tree.command").execute({ action = "focus" })
					end,
				},
				{
					event = "neo_tree_buffer_enter",
					handler = function()
						vim.opt_local.relativenumber = true
						vim.cmd("set rnu")
					end,
				},
			},
			filesystem = {
				follow_current_file = {
					enabled = true,
				},
				use_libuv_file_watcher = true,
				cwd_target = {
					sidebar = "tab",
					current = "window",
				},
				window = {
					mappings = {
						["o"] = "system_open",
						["z"] = "none", -- Unset the "z" mapping
					},
				},
			},
			commands = {
				system_open = function(state)
					local node = state.tree:get_node()
					local path = node:get_id()
					-- Use macOS 'open' command to open the file/directory
					vim.fn.jobstart({ "open", path }, { detach = true })
					-- Get the parent directory path
					local parent_path = vim.fn.fnamemodify(path, ":h")
					-- Open Finder at the parent directory
					vim.fn.jobstart({ "open", parent_path }, { detach = true })
				end,
			},
		})
	end,
}
