return {
  "folke/snacks.nvim",
  opts = function(_, opts)
    local keys = opts.dashboard.preset.keys

    -- Parses a unified diff coming from `cmd` into per-hunk picker items,
    -- each with a `diff` filetype preview. Mirrors snacks' built-in git_diff
    -- finder, but lets us point at any command (e.g. `gh pr diff`).
    local function diff_finder(cmd, cmd_args)
      ---@type snacks.picker.finder
      return function(finder_opts, ctx)
        local root = Snacks.git.get_root(vim.uv.cwd()) or vim.uv.cwd()
        local file, line ---@type string?, number?
        local header, hunk = {}, {} ---@type string[], string[]
        local header_len = 4
        local proc = require("snacks.picker.source.proc").proc({
          finder_opts,
          { cmd = cmd, args = cmd_args, cwd = root },
        }, ctx)
        return function(cb)
          local function add()
            if file and line and #hunk > 0 then
              local diff = table.concat(header, "\n") .. "\n" .. table.concat(hunk, "\n")
              cb({
                text = file .. ":" .. line,
                diff = diff,
                file = file,
                pos = { line, 0 },
                preview = { text = diff, ft = "diff", loc = false },
              })
            end
            hunk = {}
          end
          proc(function(proc_item)
            local text = proc_item.text
            if text:find("diff", 1, true) == 1 then
              add()
              file = text:match("^diff .* a/(.*) b/.*$")
              header = { text }
              header_len = 4
            elseif file and #header < header_len then
              if text:find("^deleted file") then
                header_len = 5
              end
              header[#header + 1] = text
            elseif text:find("@", 1, true) == 1 then
              add()
              -- Hunk header, e.g. "@@ -157,20 +157,6 @@ some content"
              line = tonumber(string.match(text, "@@ %-.*,.* %+(.*),.* @@"))
              hunk = { text }
            elseif #hunk > 0 then
              hunk[#hunk + 1] = text
            end
          end)
          add()
        end
      end
    end

    -- "Git Diff" entry: picker for the working-tree diff hunks
    local diff_item = {
      icon = "󰊢 ",
      key = "d",
      desc = "Git Diff",
      action = function()
        Snacks.picker.git_diff()
      end,
    }

    -- "Git Status" entry: picker for changed files with diff preview
    local status_item = {
      icon = "󰊢 ",
      key = "D",
      desc = "Git Status",
      action = function()
        Snacks.picker.git_status()
      end,
    }

    -- "Git PR Diff" entry: pipe `gh pr diff` into the diff picker
    local pr_diff_item = {
      icon = "󰊢 ",
      key = "p",
      desc = "Git PR Diff",
      action = function()
        Snacks.picker.pick({
          source = "pr_diff",
          title = "PR Diff",
          finder = diff_finder("gh", { "pr", "diff" }),
          format = "file",
          preview = "diff",
        })
      end,
    }

    -- Insert right after "Find Text" (key "g"); fall back to appending
    local pos = #keys + 1
    for i, item in ipairs(keys) do
      if item.key == "g" then
        pos = i + 1
        break
      end
    end
    table.insert(keys, pos, diff_item)
    table.insert(keys, pos + 1, status_item)
    table.insert(keys, pos + 2, pr_diff_item)
  end,
}
