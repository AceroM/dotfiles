vim.g.mapleader = " "
vim.cmd("set clipboard+=unnamedplus")
vim.cmd("set number")
vim.cmd("set rnu")
vim.cmd("set tabstop=2")
vim.cmd("set softtabstop=2")
vim.cmd("set shiftwidth=2")
vim.cmd("set expandtab")
vim.opt.swapfile = false
vim.opt.splitright = true
vim.opt.foldmethod = "expr"
vim.opt.foldexpr = "v:lua.vim.treesitter.foldexpr()"
vim.opt.foldcolumn = "0"
vim.opt.foldtext = ""
vim.opt.foldenable = false
vim.opt.foldlevel = 99
vim.opt.signcolumn = "yes:1"
vim.keymap.set("n", "-", vim.cmd.Ex)
vim.keymap.set("v", "//", "y/\\V<C-R>=escape(@\", '/\\')<CR><CR>", { noremap = true })
vim.keymap.set("n", "<BS>", '"_dd')
vim.keymap.set("v", "<BS>", '"_dd')
vim.keymap.set("n", "<CR>", "o<Esc>")
vim.keymap.set("n", "<S-CR>", "O<Esc>")
vim.keymap.set("i", "<S-CR>", "<Esc>O")
vim.keymap.set("n", "-", "k_")
vim.keymap.set("n", "<leader>i", "gg}}O")
vim.keymap.set("n", "<leader>ts", ":TailwindSort<CR>", { silent = true })
vim.keymap.set("n", "<leader>ww", ":w!<CR>", { silent = true })
vim.keymap.set("n", "<leader>wq", ":wq!<CR>", { silent = true })
vim.keymap.set("n", "<leader>wa", ":wa<CR>", { silent = true })
vim.keymap.set("n", "<leader>q", ":q!<CR>", { silent = true })
vim.keymap.set("n", "<leader>fr", function()
	return vim.fn.setreg("+", vim.fn.expand("%"))
end, { expr = true })
vim.keymap.set("n", "<leader>fp", function()
	return vim.fn.setreg("+", vim.fn.expand("%:p:."))
end, { expr = true })
vim.keymap.set("c", "<CR>", function()
	return vim.fn.getcmdtype() == "/" and "<CR>zzzv" or "<CR>"
end, { expr = true })
vim.keymap.set({ "n", "x" }, "<leader>l", function()
	vim.lsp.buf.format({ timeout = 5000 })
	vim.cmd("w")
	if vim.fn.hlexists("Search") == 1 and vim.fn.getreg("/") ~= "" then
		vim.cmd("nohlsearch")
	end
end, {})
vim.keymap.set({ "n", "x" }, "<leader>k", function()
	vim.cmd(":wqa!")
end, {})
vim.keymap.set({ "n", "x" }, "<leader>j", function()
	vim.cmd("wa")
	if vim.fn.hlexists("Search") == 1 and vim.fn.getreg("/") ~= "" then
		vim.cmd("nohlsearch")
	end
end, {})
vim.keymap.set("n", "<leader>cp", function()
	local relative_path = vim.fn.systemlist("git ls-files --full-name " .. vim.fn.shellescape(vim.fn.expand("%:p")))[1]
	if relative_path and relative_path ~= "" then
		vim.fn.setreg("+", relative_path)
		vim.notify('Copied "' .. relative_path .. '" to the clipboard!')
	else
		vim.notify("Not a git repository or file not tracked", vim.log.levels.WARN)
	end
end, {})
vim.keymap.set("n", "<C-a>", "ggVG", { silent = true })
vim.keymap.set("v", "<C-s>", [[y/\V<C-R>=escape(@",'/\')<CR><CR>Ncgn]], { desc = "Search & Replace" })
vim.keymap.set("n", "<leader>gj", ":Gvsplit disputes:%<cr>")
local function move_or_create_vsplit()
	if vim.fn.winnr("$") == 1 then
		vim.cmd("vsplit")
		vim.cmd("wincmd h")
	end
end
vim.keymap.set("n", "<C-w>t", ":tab split<cr>", { silent = true })
vim.keymap.set("n", "<C-w>;", move_or_create_vsplit)
vim.keymap.set("n", "gt", "<cmd>tab split | lua vim.lsp.buf.definition()<CR>", {})
vim.keymap.set("n", "gv", "<cmd>vsplit | lua vim.lsp.buf.definition()<CR>", {})
vim.keymap.set("n", "<Tab>", ":tabnext<CR>", { silent = true })
vim.keymap.set("n", "<S-Tab>", ":tabprevious<CR>", { silent = true })
vim.keymap.set("n", "<leader>du", ":DBUI<CR>", { silent = true, noremap = true })
vim.keymap.set("n", "<leader>h", ":nohlsearch<CR>")
vim.keymap.set("n", "<leader>gv", ":DiffviewOpen<CR>")
vim.keymap.set("n", "<leader>e", vim.diagnostic.open_float, { noremap = true, silent = true, buffer = bufnr })
vim.keymap.set("n", "<leader>;", "@q", { noremap = true, silent = true })
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
vim.keymap.set("n", "<C-s>", function()
	vim.api.nvim_command("norm! yiw")
	vim.fn.setreg("/", vim.fn.getreg("+"))
	vim.api.nvim_feedkeys("ciw", "n", false)
end, { desc = "Search & Replace" })
vim.api.nvim_set_keymap("i", "<Enter>", "v:lua.enter_or_indent_tag()", { expr = true, noremap = true })
function _G.enter_or_indent_tag()
	local line = vim.fn.getline(".")
	local col = vim.fn.col(".")
	local before = string.sub(line, col - 2, col - 2)
	local after = string.sub(line, col - 1, col - 1)
	if before == ">" and after == "<" then
		return "\n<C-o>O<Tab>"
	end
	return "\n"
end

-- vim.keymap.set("n", "<C-;>", "<C-w>o", { silent = true })
-- vim.opt.signcolumn = 'no'
local function toggle_scrollbind_all_buffers()
	local windows = vim.api.nvim_list_wins()
	local all_bound = true
	-- Check if all windows are already scrollbound
	for _, win in ipairs(windows) do
		if not vim.api.nvim_win_get_option(win, "scrollbind") then
			all_bound = false
			break
		end
	end
	-- Toggle scrollbind for all windows
	for _, win in ipairs(windows) do
		vim.api.nvim_win_set_option(win, "scrollbind", not all_bound)
	end
	local status = all_bound and "disabled" or "enabled"
	vim.notify("Scrollbind " .. status .. " for all open windows", vim.log.levels.INFO)
end

vim.keymap.set(
	"n",
	"<leader>'",
	toggle_scrollbind_all_buffers,
	{ noremap = true, silent = true, desc = "Toggle scrollbind for all buffers" }
)

vim.api.nvim_create_autocmd({ "BufNewFile", "BufRead" }, {
	pattern = "*.props",
	command = "set filetype=ruby",
})
vim.api.nvim_create_autocmd("TabLeave", {
	callback = function()
		vim.g.lasttab = vim.fn.tabpagenr()
	end,
})
-- vim.keymap.set({ "n", "v" }, "<c-m>", ":-tabmove<CR>", { silent = true })
vim.keymap.set({ "n", "v" }, "<c-,>", ":+tabmove<CR>", { silent = true })
vim.keymap.set({ "n", "v" }, "<c-.>", vim.lsp.buf.code_action, { silent = true, noremap = true })
vim.keymap.set({ "n", "v" }, "<c-'>", function()
	local count = vim.v.count1
	local line = vim.fn.getline(".")
	local lines = {}
	for _ = 1, count do
		table.insert(lines, line)
	end
	vim.api.nvim_put(lines, "l", true, true)
	vim.cmd("normal! k_")
end, { silent = true, noremap = true })
vim.keymap.set({ "n", "v" }, "<c-/>", function()
	vim.cmd("normal gcc+")
end, { silent = true, noremap = true })
vim.keymap.set({ "n", "v" }, "'", function()
	vim.cmd("tabclose")
end, { silent = true })
vim.keymap.set({ "n", "i" }, "<C-8>", "yyp", { noremap = true, silent = true })
vim.keymap.set("t", "<C-\\><C-j>", "<C-\\><C-n><C-w>j", { noremap = true, silent = true })
vim.keymap.set("t", "<C-\\><C-k>", "<C-\\><C-n><C-w>k", { noremap = true, silent = true })
vim.keymap.set("t", "<C-\\><C-h>", "<C-\\><C-n><C-w>h", { noremap = true, silent = true })
vim.keymap.set("t", "<C-\\><C-l>", "<C-\\><C-n><C-w>l", { noremap = true, silent = true })
vim.keymap.set("t", "<Esc>", "<C-\\><C-n>", { noremap = true, silent = true })

-- Center screen after jumps
vim.keymap.set("n", "n", "nzz", { noremap = true, silent = true })
vim.keymap.set("n", "N", "Nzz", { noremap = true, silent = true })

-- Map arrow keys to C-d and C-u for moving up and down
vim.keymap.set("n", "<Down>", "<C-d>zz", { noremap = true, silent = true })
vim.keymap.set("n", "<Up>", "<C-u>zz", { noremap = true, silent = true })
vim.keymap.set("n", "<Right>", ":tabnext<CR>", { silent = true })
vim.keymap.set("n", "<Left>", ":tabprevious<CR>", { silent = true })

-- open nautilus/finder on current working file
vim.api.nvim_create_user_command("Cwf", function()
	local path = vim.fn.expand("%:p:h")
	os.execute("open " .. path)
end, {})


vim.keymap.set("n", "<leader>y", function()
	local cmd = string.format(
		'osascript -e \'tell application "Finder" to set the clipboard to (POSIX file "%s")\'',
		vim.fn.expand("%:p")
	)
	vim.fn.system(cmd) -- This actually runs the command
end)
