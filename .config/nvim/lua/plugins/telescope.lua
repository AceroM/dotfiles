return {
	{
		"kdheepak/lazygit.nvim",
		dependencies = {
			"nvim-telescope/telescope.nvim",
			"nvim-lua/plenary.nvim",
		},
		config = function()
			require("telescope").load_extension("lazygit")
		end,
	},
	{
		"nvim-telescope/telescope-project.nvim",
		config = function()
			require("telescope").load_extension("project")
		end,
	},
	{
		"nvim-telescope/telescope-ui-select.nvim",
		config = function()
			require("telescope").setup({
				defaults = {
					mappings = {
						i = {
							["<esc>"] = require("telescope.actions").close,
						},
					},
				},
				extensions = {
					["ui-select"] = {
						require("telescope.themes").get_dropdown({}),
					},
				},
			})
			require("telescope").load_extension("ui-select")
		end,
	},
	{
		"nvim-telescope/telescope.nvim",
		tag = "0.1.5",
		dependencies = { "nvim-lua/plenary.nvim" },
		config = function()
			require("telescope").setup({
				extensions = {
					["ui-select"] = {
						require("telescope.themes").get_dropdown({}),
					},
				},
			})
			local builtin = require("telescope.builtin")
			local utils = require("telescope.utils")
			vim.keymap.set("n", "<leader>b", builtin.buffers, {})
			vim.keymap.set("n", "<leader>fh", builtin.help_tags, {})
			vim.keymap.set("n", "<c-j>", builtin.live_grep, { desc = "[S]earch by [G]rep" })
			vim.keymap.set("n", "<c-space>", function()
				local parent_dir = vim.fn.fnamemodify(utils.buffer_dir(), ":h")
				builtin.live_grep({ cwd = parent_dir })
			end, { desc = "Grep in parent directory" })
			-- vim.keymap.set("n", "<c-space>", function()
			-- 	builtin.live_grep({ cwd = utils.buffer_dir() })
			-- end, { desc = "Grep in current directory" })
			-- vim.keymap.set("n", "<leader>gp", function()
			-- 	local parent_dir = vim.fn.fnamemodify(utils.buffer_dir(), ":h")
			-- 	builtin.live_grep({ cwd = parent_dir })
			-- end, { desc = "Grep in parent directory" })
			vim.keymap.set("n", "<c-p>", builtin.find_files, { desc = "[S]earch [F]iles" })
			vim.keymap.set("n", "<c-k>", builtin.oldfiles, {})
			vim.keymap.set("n", "<leader>si", builtin.lsp_references, { desc = "[S]earch [I]mplementations" })
			vim.keymap.set("n", "<leader>sc", function()
				require("telescope").extensions.diff.diff_current({ hidden = true })
			end, { desc = "Compare file with current" })
			vim.keymap.set(
				"n",
				"<leader>sp",
				require("telescope").extensions.project.project,
				{ desc = "[S]earch [P]rojects" }
			)
			vim.keymap.set("n", "<leader>sh", builtin.help_tags, { desc = "[S]earch [H]elp" })
			vim.keymap.set("n", "<leader>sw", builtin.grep_string, { desc = "[S]earch current [W]ord" })
			vim.keymap.set("n", "<leader>sd", builtin.diagnostics, { desc = "[S]earch [D]iagnostics" })
			vim.keymap.set("n", "<leader><leader>", builtin.oldfiles, {})
			vim.keymap.set("n", "<c-h>", builtin.resume, { desc = "[S]earch [R]esume" })

			function vim.getVisualSelection()
				vim.cmd('noau normal! "vy"')
				local text = vim.fn.getreg("v")
				vim.fn.setreg("v", {})
				text = string.gsub(text, "\n", "")
				if #text > 0 then
					return text
				else
					return ""
				end
			end

			local keymap = vim.keymap.set
			local opts = { noremap = true, silent = true }
			keymap("v", "<c-j>", function()
				local text = vim.getVisualSelection()
				builtin.live_grep({ default_text = text })
			end, opts)
			keymap("v", "<c-p>", function()
				local text = vim.getVisualSelection()
				builtin.find_files({ default_text = text })
			end, opts)
			vim.api.nvim_set_keymap(
				"n",
				"<leader>rw",
				[[<cmd>lua require('telescope.builtin').grep_string()<cr>]],
				{ silent = true, noremap = true }
			)
			vim.api.nvim_set_keymap(
				"n",
				"<leader>rf",
				[[<cmd>lua require('telescope.builtin').grep_string({ file_ignore_patterns = { '%.js' }})<cr>]],
				{ silent = true, noremap = true }
			)
			vim.keymap.set("v", "<leader>rf", function()
				require("telescope.builtin").grep_string({ file_ignore_patterns = { "%.js" } })
			end, { silent = true, noremap = true })
		end,
	},
	{
		"jemag/telescope-diff.nvim",
		dependencies = {
			{ "nvim-telescope/telescope.nvim" },
		},
		config = function()
			require("telescope").load_extension("diff")
		end,
	},
}
