-- Fix for Neo-tree and other special buffers appearing in recent files
-- This prevents crashes when accessing recent files
return {
  {
    "LazyVim/LazyVim",
    opts = function()
      -- Function to filter out problematic entries from oldfiles
      local function filter_oldfiles()
        local oldfiles = vim.v.oldfiles or {}
        local filtered = {}
        for _, file in ipairs(oldfiles) do
          -- Filter out Neo-tree buffers and other special buffers
          if file and 
             not string.match(file, "neo%-tree") and
             not string.match(file, "%[%d+%]$") and
             not string.match(file, "^%s*$") and
             not string.match(file, "^term://") and
             not string.match(file, "^fugitive://") and
             vim.fn.filereadable(file) == 1 then
            table.insert(filtered, file)
          end
        end
        vim.v.oldfiles = filtered
      end
      
      -- Set up autocmd to filter oldfiles when vim starts
      vim.api.nvim_create_autocmd("VimEnter", {
        callback = function()
          filter_oldfiles()
        end,
      })
      
      -- Also filter when shada is written
      vim.api.nvim_create_autocmd("VimLeave", {
        callback = function()
          filter_oldfiles()
        end,
      })
      
      return {}
    end,
  },
}
