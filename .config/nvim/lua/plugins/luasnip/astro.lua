local ls = require("luasnip")
local s = ls.snippet
local t = ls.text_node
local i = ls.insert_node
return {
	s("c=", { t('class="'), i(1), t('"') }),
}
