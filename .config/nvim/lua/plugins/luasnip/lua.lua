local ls = require("luasnip")
local s = ls.snippet
local t = ls.text_node
local i = ls.insert_node

return {
	s("r ", { t("return ") }),
	s("cf ", { t("config = function()"), t({ "", "  " }), i(1), t({ "", "end" }) }),
}
