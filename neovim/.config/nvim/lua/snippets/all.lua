-- Language-agnostic autosnippets, active in every filetype except text and
-- extensionless buffers (see plugins/snippets.lua). Anything tied to a
-- language belongs in that language's file instead (web.lua for JS/TS).
local ls = require("luasnip")
local s = ls.snippet
local f = ls.function_node
local t = ls.text_node

local function return_filename()
  return vim.fn.expand("%:t:r")
end

return {
  s("fc;", { f(return_filename) }),
  s("l8", { t("http://localhost:8080") }),
  s("l3", { t("http://localhost:3000") }),
  s("cj,", { t("content-type: application/json") }),
  s("aj,", { t("accept: application/json") }),
  s("aa,", { t("authorization: {{AUTH}}") }),
  s("mgm", { t("miguelacero528@gmail.com") }),
  s("t;", {
    f(function()
      return os.date("!%Y-%m-%dT%H:%M:%SZ")
    end),
  }),
}
