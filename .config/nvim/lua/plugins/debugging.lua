return {
	{
		"theHamsta/nvim-dap-virtual-text",
		config = function()
			require("nvim-dap-virtual-text").setup({
				enabled = true,
				enabled_commands = true,
				highlight_changed_variables = true,
				highlight_new_as_changed = false,
				show_stop_reason = true,
				commented = false,
				only_first_definition = true,
				all_references = false,
				filter_references_pattern = "<module",
				virt_text_pos = "eol",
				all_frames = false,
				virt_lines = false,
				virt_text_win_col = nil,
			})
		end,
	},
	{
		"mfussenegger/nvim-dap",
		event = "BufRead",
		dependencies = {
			"nvim-neotest/nvim-nio",
			"rcarriga/nvim-dap-ui",
			"mxsdev/nvim-dap-vscode-js",
		},
		config = function()
			local dap = require("dap")
			local dapui = require("dapui")
			require("dapui").setup({
				icons = { expanded = "▾", collapsed = "▸" },
				mappings = {
					expand = { "<CR>", "<2-LeftMouse>" },
					open = "o",
					remove = "d",
					edit = "e",
					repl = "r",
					toggle = "t",
				},
				expand_lines = vim.fn.has("nvim-0.7"),
				layouts = {
					{
						elements = {
							{
								id = "scopes",
								size = 1,
							},
						},
						position = "right",
						size = 30,
					},
					{
						elements = {
							{
								id = "console",
								size = 1,
							},
						},
						position = "bottom",
						size = 10,
					},
				},
				-- layouts = {
				--   {
				--     elements = { { id = "console", size = 1 } },
				--     size = 30,
				--     position = "right",
				--   },
				-- },
				floating = {
					max_height = nil,
					max_width = nil,
					border = "rounded",
					mappings = {
						close = { "q", "<Esc>" },
					},
				},
				windows = { indent = 1 },
				render = {
					max_type_length = nil,
				},
			})
			dap.listeners.after.event_initialized["dapui_config"] = function()
				vim.cmd("tabfirst|tabnext")
				dapui.open()
			end
			dap.listeners.before.attach.dapui_config = function()
				dapui.open()
			end
			dap.listeners.before.launch.dapui_config = function()
				dapui.open()
			end
			dap.listeners.before.event_terminated.dapui_config = function()
				dapui.close()
			end
			dap.listeners.before.event_exited.dapui_config = function()
				dapui.close()
			end
			vim.cmd([[autocmd FileType dap-float nnoremap <buffer><silent> q <cmd>close!<CR>]])
			vim.keymap.set("n", "<F13>", dap.toggle_breakpoint, {})
			vim.keymap.set("n", "<F7>", dap.step_into, {})
			vim.keymap.set("n", "<F8>", dap.step_over, {})
			vim.keymap.set("n", "<F20>", dap.step_out, {})
			vim.keymap.set("n", "<F9>", dap.continue, {})
			vim.keymap.set("n", "<F21>", dap.run_to_cursor, {})
			vim.keymap.set("n", "<leader>dd", dap.disconnect, {})
			vim.keymap.set("n", "<leader>dq", dap.close, {})
			vim.keymap.set("n", "<F5>", dap.toggle_breakpoint, {})
			vim.keymap.set("n", "<leader>dx", dap.clear_breakpoints, {})
			vim.keymap.set("n", "<leader>dr", dap.repl.toggle, {})
			vim.keymap.set({ "n", "v" }, "<S-u>", function()
				require("dap.ui.widgets").hover()
			end)
			vim.keymap.set({ "n", "v" }, "<Leader>dn", function()
				require("dap-go").debug_test()
			end)
			vim.keymap.set({ "n", "v" }, "<Leader>dp", function()
				require("dap.ui.widgets").preview()
			end)
			vim.keymap.set("n", "<Leader>df", function()
				local widgets = require("dap.ui.widgets")
				widgets.centered_float(widgets.frames)
			end)
			vim.keymap.set("n", "<Leader>ds", function()
				local widgets = require("dap.ui.widgets")
				widgets.centered_float(widgets.scopes)
			end)
			vim.keymap.set("n", "<Leader>dc", function()
				dap.run({
					type = "pwa-node",
					request = "launch",
					name = "Debug Current File",
					program = "${file}",
					cwd = "${workspaceFolder}",
				})
			end)
			dap.adapters["pwa-node"] = {
				type = "server",
				host = "localhost",
				port = "3005",
				executable = {
					command = "node",
					args = {
						os.getenv("DAP_JS_DEBUG_PATH") or "/home/miguel/.dap/js-debug/src/dapDebugServer.js",
						"3005",
					},
				},
			}
			local exts = { "javascript", "typescript", "javascriptreact", "typescriptreact" }
			for _, ext in ipairs(exts) do
				dap.configurations[ext] = {
					{
						type = "pwa-node",
						request = "launch",
						name = "Ruby Server",
						runtimeExecutable = "npm",
						runtimeArgs = {
							"run",
							"doppler-debug",
						},
						rootPath = "${workspaceFolder}",
						cwd = "${workspaceFolder}",
						console = "integratedTerminal",
						internalConsoleOptions = "neverOpen",
					},
					{
						type = "pwa-node",
						request = "launch",
						name = "Ruby Server Test",
						runtimeExecutable = "doppler",
						runtimeArgs = { "run", "test" },
						rootPath = "${workspaceFolder}",
						cwd = "${workspaceFolder}",
						console = "integratedTerminal",
						internalConsoleOptions = "neverOpen",
					},
					{
						type = "pwa-node",
						request = "launch",
						name = "Development",
						runtimeExecutable = "npm",
						runtimeArgs = { "run", "dev" },
						rootPath = "${workspaceFolder}",
						cwd = "${workspaceFolder}",
						console = "integratedTerminal",
						internalConsoleOptions = "neverOpen",
					},
					{
						type = "pwa-node",
						request = "launch",
						name = "Bun Development",
						runtimeExecutable = "bun",
						runtimeArgs = { "run", "dev" },
						rootPath = "${workspaceFolder}",
						cwd = "${workspaceFolder}",
						console = "integratedTerminal",
						internalConsoleOptions = "neverOpen",
					},
					{
						type = "pwa-node",
						request = "launch",
						name = "Bun Script",
						runtimeExecutable = "bun",
						runtimeArgs = { "run", "script" },
						rootPath = "${workspaceFolder}",
						cwd = "${workspaceFolder}",
						console = "integratedTerminal",
						internalConsoleOptions = "neverOpen",
					},
					{
						type = "pwa-node",
						request = "launch",
						name = "Systems Development",
						runtimeExecutable = "npm",
						runtimeArgs = { "run", "systems-dev" },
						rootPath = "${workspaceFolder}",
						cwd = "${workspaceFolder}",
						console = "integratedTerminal",
						internalConsoleOptions = "neverOpen",
					},
					{
						type = "pwa-node",
						request = "attach",
						name = "Attach",
						cwd = "${workspaceFolder}",
						processId = require("dap.utils").pick_process,
						sourceMaps = true,
						continueOnAttach = true,
						skipFiles = {
							"<node_internals>/**",
							"**/cls-hooked/**",
						},
					},
				}
			end
		end,
	},
}
