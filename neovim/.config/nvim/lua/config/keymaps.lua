-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

-- Disable swap files
vim.opt.swapfile = false

vim.keymap.set("n", "<BS>", '"_dd')
vim.keymap.set("v", "<BS>", '"_dd')
vim.keymap.set("n", "<CR>", "o<Esc>")
vim.keymap.set("n", "<S-CR>", "O<Esc>")
vim.keymap.set("i", "<S-CR>", "<C-o>o", { noremap = true, silent = true })
vim.keymap.set("n", "<C-a>", "ggVG", { desc = "Select entire file" })
vim.keymap.set("n", "<C-j>", "yyp", { desc = "Copy down" })
vim.keymap.set("n", "<C-k>", "yyP", { desc = "Copy up" })
-- Highlight word under cursor without moving
vim.keymap.set("n", "<F2>", "*N", { desc = "Highlight current word" })
vim.keymap.set("n", "<C-p>", function()
  Snacks.picker.files()
end, { desc = "Find files" })
-- Resume the last picker (e.g. dashboard "p" PR diff) with its previous
-- cursor position/state, so you can jump back in and keep navigating.
vim.keymap.set("n", "<C-g>", function()
  Snacks.picker.resume()
end, { desc = "Resume last picker" })
-- `'` opens the diffshub prompt modal (normal + visual). Owned by the diffshub
-- plugin (lua/plugins/diffshub.lua); set there so this VeryLazy file can't clobber it.
vim.keymap.set({ "n", "v" }, "<c-/>", function()
  vim.cmd("normal gcc+")
end, { silent = true, noremap = true })

-- Copy current file's relative path
vim.keymap.set("n", "<leader>cp", function()
  local file_path = vim.fn.expand("%:p")
  local git_root = vim.fn.systemlist("git rev-parse --show-toplevel")[1]
  if git_root and file_path:find(git_root, 1, true) then
    file_path = file_path:sub(#git_root + 2) -- +2 to skip the trailing slash
  end
  vim.fn.setreg("+", file_path)
  vim.notify("Copied relative path: " .. file_path)
end, { desc = "Copy current file's relative path" })

-- Copy current file's relative path
vim.keymap.set("n", "<A-/>", function()
  local file_path = vim.fn.expand("%:p")
  local git_root = vim.fn.systemlist("git rev-parse --show-toplevel")[1]
  if git_root and file_path:find(git_root, 1, true) then
    file_path = file_path:sub(#git_root + 2) -- +2 to skip the trailing slash
  end
  vim.fn.setreg("+", file_path)
  vim.notify("Copied relative path: " .. file_path)
end, { desc = "Copy current file's relative path" })

-- Copy current filename only
vim.keymap.set("n", "<leader>cn", function()
  local filename = vim.fn.expand("%:t")
  vim.fn.setreg("+", filename)
  vim.notify("Copied filename: " .. filename)
end, { desc = "Copy current filename" })

-- Copy entire file to clipboard without moving cursor
vim.keymap.set("n", "<C-y>", function()
  local pos = vim.api.nvim_win_get_cursor(0)
  vim.cmd('silent %y+')
  vim.api.nvim_win_set_cursor(0, pos)
end, { desc = "Copy entire file to clipboard", silent = true })

-- Send to the clipboard of whatever device I'm physically on, via OSC 52.
-- Unlike an `ssh box pbcopy` relay (which only ever targets one fixed machine),
-- OSC 52 rides the terminal connection back to the device in front of me — Mac,
-- Windows Terminal, Android (Termux), iOS (Blink) — so it adapts to wherever I
-- SSH'd from, with zero per-machine setup. Forced directly here (not via the +
-- register) so it works the same locally and remotely. Needs the terminal
-- emulator (and any tmux in between) to honor OSC 52 — see the tmux `Ms` override.
local function osc52_send(lines)
  require("vim.ui.clipboard.osc52").copy("+")(lines)
end

vim.keymap.set("n", "<leader>y", function()
  osc52_send(vim.api.nvim_buf_get_lines(0, 0, -1, false))
  vim.notify("Sent buffer to local clipboard (OSC 52)")
end, { desc = "Send buffer to local clipboard (OSC 52)" })

vim.keymap.set("v", "<leader>y", function()
  vim.cmd('noautocmd normal! "zy')
  osc52_send(vim.split(vim.fn.getreg("z"), "\n", { plain = true }))
  vim.notify("Sent selection to local clipboard (OSC 52)")
end, { desc = "Send selection to local clipboard (OSC 52)" })

vim.keymap.set("n", "<C-;>", 'ggdG', { desc = "Clear entire file" })
vim.keymap.set("n", "<A-Down>", "<C-d>", { desc = "Half-page down" })
vim.keymap.set("n", "<A-Up>", "<C-u>", { desc = "Half-page up" })

-- Toggle inline visibility of all git hunks in the current file
-- (line highlight + inline deleted lines + word-level diff)
local git_hunks_shown = false
vim.keymap.set("n", "<leader>gH", function()
  local ok, gs = pcall(require, "gitsigns")
  if not ok then
    return
  end
  git_hunks_shown = not git_hunks_shown
  gs.toggle_linehl(git_hunks_shown)
  gs.toggle_deleted(git_hunks_shown)
  gs.toggle_word_diff(git_hunks_shown)
  gs.refresh()
  vim.notify("Git hunks " .. (git_hunks_shown and "shown" or "hidden"))
end, { desc = "Toggle visibility of all git hunks" })

-- :PRDiff — the whole `gh pr diff` in ONE scrollable buffer (Zed-multibuffer-ish).
-- Improves on `gh pr diff | bat`: real nvim motions/search, per-file folds, and
-- <CR> jumps into the actual file at the hunk's line. Note: ft=diff only colors
-- the diff itself (+/- lines, hunk headers), not per-language syntax — for full
-- syntax review use diffview (<leader>gd / :DiffviewOpen origin/main...HEAD).

-- Fold each file's section (a fold starts at every "diff --git ..." line).
function _G.prdiff_foldexpr()
  return vim.fn.getline(vim.v.lnum):match("^diff ") and ">1" or "1"
end

-- From the cursor, walk up to find the file (+++ b/…) and nearest hunk header,
-- compute the corresponding new-file line, and open it in a vertical split.
local function prdiff_jump()
  local cur = vim.api.nvim_win_get_cursor(0)[1]
  local file, hunk_line, new_start
  for l = cur, 1, -1 do
    local line = vim.fn.getline(l)
    if not new_start then
      local s = line:match("^@@ %-%d+,?%d* %+(%d+)")
      if s then
        hunk_line, new_start = l, tonumber(s)
      end
    end
    if not file then
      file = line:match("^%+%+%+ b/(%S+)") or line:match("^diff %-%-git a/%S+ b/(%S+)")
    end
    if line:match("^diff ") then
      break
    end
  end
  if not file then
    vim.notify("PRDiff: no file under cursor", vim.log.levels.WARN)
    return
  end
  local target = new_start or 1
  if hunk_line then
    local count = 0
    for l = hunk_line + 1, cur do
      if vim.fn.getline(l):sub(1, 1) ~= "-" then -- deletions don't advance the new file
        count = count + 1
      end
    end
    target = new_start + math.max(count - 1, 0)
  end
  local root = vim.fn.systemlist({ "git", "rev-parse", "--show-toplevel" })[1] or ""
  local path = root ~= "" and (root .. "/" .. file) or file
  vim.cmd("vsplit " .. vim.fn.fnameescape(path))
  pcall(vim.api.nvim_win_set_cursor, 0, { target, 0 })
end

local prdiff_buf
local function open_pr_diff()
  local out = vim.fn.systemlist({ "gh", "pr", "diff" })
  if vim.v.shell_error ~= 0 then
    vim.notify(table.concat(out, "\n"), vim.log.levels.ERROR, { title = "PRDiff" })
    return
  end
  if not (prdiff_buf and vim.api.nvim_buf_is_valid(prdiff_buf)) then
    prdiff_buf = vim.api.nvim_create_buf(false, true) -- unlisted scratch
    vim.bo[prdiff_buf].buftype = "nofile"
    vim.bo[prdiff_buf].bufhidden = "hide" -- keep it around after <CR> jumps
    vim.bo[prdiff_buf].swapfile = false
    vim.api.nvim_buf_set_name(prdiff_buf, "PR Diff")
    vim.keymap.set("n", "<CR>", prdiff_jump, { buffer = prdiff_buf, desc = "PRDiff: open file at hunk" })
  end
  vim.bo[prdiff_buf].modifiable = true
  vim.api.nvim_buf_set_lines(prdiff_buf, 0, -1, false, out)
  vim.bo[prdiff_buf].modifiable = false
  vim.bo[prdiff_buf].filetype = "diff"
  vim.api.nvim_set_current_buf(prdiff_buf)
  vim.wo.wrap = false
  vim.wo.foldmethod = "expr"
  vim.wo.foldexpr = "v:lua.prdiff_foldexpr()"
  vim.wo.foldenable = true
  vim.wo.foldlevel = 99 -- start fully expanded; zM collapses to one line per file
  vim.api.nvim_win_set_cursor(0, { 1, 0 })
end

vim.api.nvim_create_user_command("PRDiff", open_pr_diff, { desc = "Open full PR diff in one scrollable buffer" })
vim.keymap.set("n", "<leader>gp", open_pr_diff, { desc = "PR diff (single scroll buffer)" })

-- Go to definition in vertical/horizontal splits
vim.keymap.set(
  "n",
  "gv",
  "<cmd>vsplit | lua vim.lsp.buf.definition()<CR>",
  { desc = "Go to definition in vertical split" }
)
vim.keymap.set(
  "n",
  "gh",
  "<cmd>split | lua vim.lsp.buf.definition()<CR>",
  { desc = "Go to definition in horizontal split" }
)
