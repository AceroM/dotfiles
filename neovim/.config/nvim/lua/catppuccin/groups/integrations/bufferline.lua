-- Compatibility shim for Catppuccin's bufferline integration
-- Some versions/plugins expect `require("catppuccin.groups.integrations.bufferline").get()`.
-- If the upstream API changes, this shim ensures a safe no-op to avoid crashes.
local M = {}

function M.get()
  -- Return an empty highlights table to let Bufferline work with defaults
  return {}
end

return M

