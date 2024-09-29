local ls = require("luasnip")
local s = ls.snippet
local t = ls.text_node
local i = ls.insert_node

return {
	s("c=", { t('class="'), i(1), t('"') }),
	s("dv", { t("data-"), i(1), t('-value="'), i(2), t('"') }),
	s("; ", { t("<%= "), i(1), t({ " %>" }) }),
	s("lt ", { t("<%= link_to "), i(1), t({ " %>" }) }),
	s("bt ", { t("<%= button_to "), i(1), t({ " %>" }) }),
	s("fi ", { t("<%= if "), i(1), t({ " %>", "<% end %>" }) }),
	s("dc", { t('data-controller="'), i(1), t('"') }),
	s("h1.", { t('<h1 class="'), i(1), t('">'), i(2), t("</h1>") }),
	s("h2.", { t('<h2 class="'), i(1), t('">'), i(2), t("</h2>") }),
	s("h3.", { t('<h3 class="'), i(1), t('">'), i(2), t("</h3>") }),
	s("h4.", { t('<h4 class="'), i(1), t('">'), i(2), t("</h4>") }),
	s("tbl", { t({ '<table class="table">', "  " }), i(1), t({ "", "</table>" }) }),
	s("sl,", { t({ '<select class="select" ' }), i(1), t({ ">", "</select>" }) }),
	s("tr.", { t('<tr class="'), i(1), t('">'), i(2), t("</tr>") }),
	s("th.", { t('<th class="'), i(1), t('">'), i(2), t("</th>") }),
	s("td.", { t('<td class="'), i(1), t('">'), i(2), t("</td>") }),
	s("l,", { t('<label class="label" htmlFor="'), i(1), t('">'), i(2), t("</label>") }),
	s("d.", { t('<div class="'), i(1), t('">'), i(2), t("</div>") }),
	s("dl.", { t('<dl class="'), i(1), t('">'), i(2), t("</dl>") }),
	s("dt.", { t('<dt class="'), i(1), t('">'), i(2), t("</dt>") }),
	s("dd.", { t('<dd class="'), i(1), t('">'), i(2), t("</dd>") }),
	s("fr.", { t('<form class="'), i(1), t('">'), i(2), t("</form>") }),
	s("b.", { t('<button class="'), i(1), t('">'), i(2), t("</button>") }),
	s("s.", { t('<span class="'), i(1), t('">'), i(2), t("</span>") }),
	s("p.", { t('<p class="'), i(1), t('">'), i(2), t("</p>") }),
	s("s.", { t("style={styles."), i(1), t("}") }),
	s("it.", { t('<input type="text" class="'), i(1), t('" />') }),
}
