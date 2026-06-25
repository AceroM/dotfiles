-- diffshub.nvim — a centered prompt modal that fires a prompt at the local
-- diffshub server (http://localhost:3433), which launches a Claude session for
-- it (POST /api/claude → { ok, session }). Bound to `'`.
--
-- In normal mode it's just an input box. In visual mode it grabs the highlighted
-- text first and shows it (file + line range + the lines themselves, syntax
-- highlighted) right above the input, so you can see the context being attached;
-- the selection is folded into the prompt as a fenced code block on send.

local M = {}

-- Defaults; override via require("diffshub").setup({ ... }).
local config = {
  url = "http://localhost:3433", -- diffshub base URL
  endpoint = "/api/claude", -- launch-a-session route
  dir = nil, -- optional diffshub directory id (?dir=<n>); nil = its launch cwd
  timeout = 60, -- curl --max-time, seconds
  width = 80, -- modal width in columns (clamped to the screen)
  input_height = 6, -- height of the prompt box, in rows
  preview_height = 12, -- max rows of selected text to preview
}

-- The currently-open modal, so a second `'` focuses it instead of stacking.
local state = nil

-- File path of `buf`, relative to its git root (falling back to a cwd-relative
-- path), for a compact "From `path`" header in the prompt.
local function relpath(buf)
  local name = vim.api.nvim_buf_get_name(buf)
  if name == "" then
    return "[No Name]"
  end
  local root = vim.fs.root(buf, ".git")
  if root and name:sub(1, #root + 1) == root .. "/" then
    return name:sub(#root + 2)
  end
  return vim.fn.fnamemodify(name, ":~:.")
end

-- The current visual selection, or nil if we're not in a visual mode. Must be
-- called while the selection is still live (we trigger via a <Cmd> mapping, which
-- preserves visual mode), reading the two ends with getpos("v")/getpos(".") and
-- the exact text with getregion() (handles char/line/block-wise alike).
local function get_selection()
  local mode = vim.api.nvim_get_mode().mode
  if mode ~= "v" and mode ~= "V" and mode ~= "\22" then
    return nil
  end
  local buf = vim.api.nvim_get_current_buf()
  local p1, p2 = vim.fn.getpos("v"), vim.fn.getpos(".")
  local ok, region = pcall(vim.fn.getregion, p1, p2, { type = mode })
  local text
  if ok and region and #region > 0 then
    text = region
  else -- fall back to whole-line grab if getregion is unhappy
    local a, b = math.min(p1[2], p2[2]), math.max(p1[2], p2[2])
    text = vim.api.nvim_buf_get_lines(buf, a - 1, b, false)
  end
  return {
    text = text,
    l1 = math.min(p1[2], p2[2]),
    l2 = math.max(p1[2], p2[2]),
    file = relpath(buf),
    ft = vim.bo[buf].filetype,
  }
end

-- Stitch the typed prompt and (optional) selection into the text we send. The
-- selection becomes a fenced block tagged with the source path + line range; the
-- fence grows past any backticks inside the snippet so it can't be broken out of.
local function build_prompt(input_lines, sel)
  local prompt = vim.trim(table.concat(input_lines, "\n"))
  if not (sel and sel.text and #sel.text > 0) then
    return prompt
  end
  local body = table.concat(sel.text, "\n")
  local fence = "```"
  while body:find(fence, 1, true) do
    fence = fence .. "`"
  end
  local block = table.concat({
    string.format("From `%s` (lines %d-%d):", sel.file, sel.l1, sel.l2),
    fence .. (sel.ft ~= "" and sel.ft or ""),
    body,
    fence,
  }, "\n")
  return prompt == "" and block or (prompt .. "\n\n" .. block)
end

-- POST the prompt to diffshub asynchronously via curl, then notify the result.
-- Body goes over stdin (--data-binary @-) so a long/quote-heavy prompt can't trip
-- argv limits or shell quoting.
local function send(prompt)
  if prompt == "" then
    vim.notify("diffshub: empty prompt — nothing sent", vim.log.levels.WARN)
    return
  end
  local url = config.url .. config.endpoint
  if config.dir then
    url = url .. "?dir=" .. tostring(config.dir)
  end
  vim.notify("diffshub: sending…", vim.log.levels.INFO)
  vim.system({
    "curl",
    "-sS",
    "--connect-timeout",
    "3",
    "--max-time",
    tostring(config.timeout),
    "-X",
    "POST",
    "-H",
    "Content-Type: application/json",
    "--data-binary",
    "@-",
    url,
  }, { stdin = vim.json.encode({ prompt = prompt }), text = true }, function(res)
    vim.schedule(function()
      if res.code ~= 0 then
        vim.notify(
          "diffshub: request failed (curl exit " .. res.code .. ")\n" .. (res.stderr or ""),
          vim.log.levels.ERROR
        )
        return
      end
      local ok, data = pcall(vim.json.decode, res.stdout or "")
      if not ok or type(data) ~= "table" then
        vim.notify("diffshub: unexpected response:\n" .. (res.stdout or ""), vim.log.levels.ERROR)
      elseif data.error then
        vim.notify("diffshub: " .. tostring(data.error), vim.log.levels.ERROR)
      elseif data.queued then
        vim.notify("diffshub: offline — prompt queued, will launch when back online", vim.log.levels.WARN)
      elseif data.session then
        vim.notify("diffshub: launched session “" .. tostring(data.session) .. "”", vim.log.levels.INFO)
      else
        vim.notify("diffshub: sent", vim.log.levels.INFO)
      end
    end)
  end)
end

-- Tear down the modal (input + optional preview). Idempotent; clears the autocmd
-- group first so the WinClosed/BufLeave hooks don't recurse back in.
local function close()
  if not state then
    return
  end
  local s = state
  state = nil
  pcall(vim.api.nvim_del_augroup_by_id, s.augroup)
  for _, win in ipairs({ s.preview_win, s.input_win }) do
    if win and vim.api.nvim_win_is_valid(win) then
      pcall(vim.api.nvim_win_close, win, true)
    end
  end
end

-- A scratch buffer that wipes itself when hidden.
local function scratch_buf()
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].bufhidden = "wipe"
  return buf
end

-- Open the centered modal. `sel` (or nil) is the captured visual selection; when
-- present, a read-only, syntax-highlighted preview of it sits above the input.
local function open(sel)
  if state and state.input_win and vim.api.nvim_win_is_valid(state.input_win) then
    vim.api.nvim_set_current_win(state.input_win)
    return
  end

  local cols, rows = vim.o.columns, vim.o.lines
  local width = math.max(20, math.min(config.width, cols - 8))
  local input_h = math.max(3, math.min(config.input_height, rows - 6))

  -- Preview sizing (only when there's a selection).
  local prev_h = 0
  if sel then
    prev_h = math.max(1, math.min(#sel.text, config.preview_height, rows - input_h - 7))
  end

  -- Total visual height of the stack (each float adds 2 border rows; 1-row gap
  -- between the two). Center the whole block; `top` is the topmost border row.
  local stack_h = input_h + 2 + (sel and (prev_h + 2 + 1) or 0)
  local top = math.max(0, math.floor((rows - stack_h) / 2))
  local col = math.max(0, math.floor((cols - width) / 2))

  local augroup = vim.api.nvim_create_augroup("DiffshubModal", { clear = true })
  state = { augroup = augroup }

  -- Preview window (selected text), stacked on top.
  if sel then
    local pbuf = scratch_buf()
    vim.api.nvim_buf_set_lines(pbuf, 0, -1, false, sel.text)
    vim.bo[pbuf].modifiable = false
    if sel.ft ~= "" then
      vim.bo[pbuf].filetype = sel.ft
    end
    state.preview_win = vim.api.nvim_open_win(pbuf, false, {
      relative = "editor",
      width = width,
      height = prev_h,
      row = top + 1, -- +1: content sits one row below its top border
      col = col + 1,
      style = "minimal",
      border = "rounded",
      title = string.format(" %s:%d-%d · %d line%s ", sel.file, sel.l1, sel.l2, #sel.text, #sel.text == 1 and "" or "s"),
      title_pos = "left",
      focusable = false,
      zindex = 50,
    })
    vim.wo[state.preview_win].wrap = false
    vim.wo[state.preview_win].winhighlight = "NormalFloat:NormalFloat,FloatBorder:Comment"
  end

  -- Input window (the prompt), below the preview (or centered alone).
  local ibuf = scratch_buf()
  local input_top = sel and (top + 1 + prev_h + 2) or top -- below preview + its border + gap
  state.input_win = vim.api.nvim_open_win(ibuf, true, {
    relative = "editor",
    width = width,
    height = input_h,
    row = input_top + 1,
    col = col + 1,
    style = "minimal",
    border = "rounded",
    title = sel and " diffshub  (+ selection) " or " diffshub ",
    title_pos = "center",
    footer = " <C-s>/<CR> send   <Esc> cancel ",
    footer_pos = "center",
    zindex = 60,
  })
  vim.wo[state.input_win].wrap = true
  vim.wo[state.input_win].linebreak = true

  -- Submit reads the input, closes the modal, then sends (closing first so the
  -- notify isn't drawn under the float).
  local function submit()
    local lines = vim.api.nvim_buf_get_lines(ibuf, 0, -1, false)
    close()
    send(build_prompt(lines, sel))
  end

  local map = function(modes, lhs, fn)
    vim.keymap.set(modes, lhs, fn, { buffer = ibuf, nowait = true, silent = true })
  end
  map({ "n", "i" }, "<C-s>", submit)
  map("n", "<CR>", submit)
  map("n", "<Esc>", close)
  map("n", "q", close)
  map("i", "<C-c>", close)

  -- If focus leaves the input (click away, :q, etc.), dismiss the whole modal.
  vim.api.nvim_create_autocmd({ "WinLeave", "BufLeave" }, {
    group = augroup,
    buffer = ibuf,
    callback = close,
  })

  vim.cmd("startinsert")
end

-- Normal-mode entry: a blank prompt.
function M.ask()
  open(nil)
end

-- Visual-mode entry: capture the selection first, then open with it attached.
-- Bound via a <Cmd> mapping so the selection is still live when this runs.
function M.ask_visual()
  open(get_selection())
end

function M.setup(opts)
  config = vim.tbl_deep_extend("force", config, opts or {})

  vim.keymap.set("n", "'", M.ask, { desc = "diffshub: prompt", silent = true })
  vim.keymap.set(
    "x",
    "'",
    "<Cmd>lua require('diffshub').ask_visual()<CR>",
    { desc = "diffshub: prompt with selection", silent = true }
  )
  vim.api.nvim_create_user_command("Diffshub", M.ask, { desc = "diffshub: prompt" })
end

return M
