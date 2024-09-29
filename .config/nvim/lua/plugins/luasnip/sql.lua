local ls = require("luasnip")
local s = ls.snippet
local t = ls.text_node
local i = ls.insert_node

return {
	s("sf", { t("SELECT * FROM "), i(1) }),
	s("sw", { t("SELECT * FROM "), i(1), t(" WHERE "), i(2) }),
	s("w", { t("WHERE "), i(1) }),
	s("il", { t("ilike '%"), i(1), t("%'") }),
	s("uw", { t("UPDATE "), i(1), t(" SET "), i(2), t(" WHERE "), i(3) }),
	s("df", { t("DELETE FROM "), i(1) }),
	s("dw", { t("DELETE FROM "), i(1), t(" WHERE "), i(2) }),
	s("li", { t("LIMIT "), i(1) }),
	s("ob", { t("ORDER BY "), i(1) }),
	s("obd", { t("ORDER BY "), i(1), t(" DESC") }),
}
