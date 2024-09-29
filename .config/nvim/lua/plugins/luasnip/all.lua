local ls = require("luasnip")
local s = ls.snippet
local t = ls.text_node
local i = ls.insert_node

return {
	s("l8", { t("http://localhost:8080") }),
	s("l3", { t("http://localhost:3000") }),
	s("cj,", { t("content-type: application/json") }),
	s("aj,", { t("accept: application/json") }),
	s("aa,", { t("authorization: {{AUTH}}") }),
	s("mgm", { t("miguelacero528@gmail.com") }),
	s("dr ", { t("debugger") }),
}
