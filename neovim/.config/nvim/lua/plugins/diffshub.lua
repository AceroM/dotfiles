-- diffshub.nvim — local plugin (lives in <config>/diffshub). Binds `'` to a
-- centered prompt modal that POSTs to the diffshub server on localhost:3433,
-- which spins up a Claude session for the prompt. In visual mode the highlighted
-- text is shown in the modal and attached to the prompt. See diffshub/lua/diffshub.
--
-- Loaded eagerly (lazy=false): setup() only registers the `'` maps + :Diffshub
-- command, so there's no real startup cost and the binding is ready immediately.
return {
  dir = vim.fn.stdpath("config") .. "/diffshub",
  name = "diffshub",
  lazy = false,
  config = function()
    require("diffshub").setup({
      url = "http://localhost:3433",
    })
  end,
}
