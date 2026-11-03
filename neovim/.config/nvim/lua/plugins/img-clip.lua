-- Paste clipboard images into the buffer as files. macOS needs `pngpaste`
-- (Brewfile).
--
-- In an agent's ctrl+g prompt file (Claude Code's `claude-prompt-*.md`, or any
-- file in a temp dir, like Codex's) the image goes to a stable cache dir and is
-- inserted as a bare absolute path, which Claude reads as an image. Everywhere
-- else img-clip's defaults apply (`assets/`, markdown image syntax).
--
-- Keys:
--   p / P     normal p/P, unless the clipboard holds only an image (pbpaste is
--             empty): then the image path is put below / above, like a
--             linewise p/P. Named registers ("ap) are never intercepted.
--   <C-v>     insert mode only: same, else the usual literal insert. Normal-mode
--             <C-v> is still visual block.
--   <leader>ip  :PasteImage

local function is_agent_prompt_file()
  local name = vim.api.nvim_buf_get_name(0)
  if name:match("/claude%-prompt%-[^/]*%.md$") then
    return true
  end
  local tmp = (vim.env.TMPDIR or ""):gsub("/$", "")
  for _, dir in ipairs({ tmp, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders" }) do
    if dir ~= "" and name:sub(1, #dir + 1) == dir .. "/" then
      return true
    end
  end
  return false
end

-- Only when the clipboard has no text: pbpaste comes back empty for an
-- image-only clipboard, so ordinary text pastes never pay for the pngpaste check.
local function clipboard_is_image()
  return vim.fn.getreg("+") == "" and require("img-clip.clipboard").content_is_image()
end

-- expr mappings can't edit the buffer, so the paste is scheduled right after.
local function paste_image_later(opts)
  vim.schedule(function()
    require("img-clip").paste_image(opts)
  end)
  return ""
end

local function put(key)
  return function()
    local reg = vim.v.register
    if (reg == '"' or reg == "+" or reg == "*") and clipboard_is_image() then
      return paste_image_later({ insert_template_after_cursor = key == "p", insert_mode_after_paste = false })
    end
    return key
  end
end

return {
  "HakonHarnes/img-clip.nvim",
  event = "VeryLazy",
  opts = {
    custom = {
      {
        trigger = is_agent_prompt_file,
        dir_path = vim.fn.stdpath("cache") .. "/pasted-images",
        use_absolute_path = true,
        relative_to_current_file = false,
        prompt_for_file_name = false,
        template = "$FILE_PATH",
      },
    },
  },
  keys = {
    { "p", put("p"), expr = true, desc = "Put (clipboard image as a file)" },
    { "P", put("P"), expr = true, desc = "Put above (clipboard image as a file)" },
    { "<leader>ip", "<cmd>PasteImage<cr>", desc = "Paste image from clipboard" },
    {
      "<C-v>",
      function()
        if not clipboard_is_image() then
          return "<C-v>"
        end
        return paste_image_later()
      end,
      mode = "i",
      expr = true,
      desc = "Paste clipboard image, else literal insert",
    },
  },
}
