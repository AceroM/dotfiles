local ls = require("luasnip")
local s = ls.snippet
local t = ls.text_node
local i = ls.insert_node

return {
	s("hc", { t("height: fit-content;") }),
	s("wc", { t("width: fit-content;") }),
	s("bs", { t("box-shadow: "), i(1), t(";") }),
	s("oya", { t("overflow-y: auto;") }),
	s("oxa", { t("overflow-x: auto;") }),
	s("ovh", { t("overflow: hidden;") }),
	s("wsn", { t("white-space: nowrap;") }),
	s("wf", { t("width: 100%;") }),
	s("hf", { t("height: 100%;") }),
	s("w ", { t("width: "), i(1), t(";") }),
	s("h ", { t("height: "), i(1), t(";") }),
	s("mq", { t("@media (width"), i(1), t(") {"), i(0), t({ "", "}" }) }),
	s("cl", { t("color: "), i(1), t(";") }),
	s("pos", { t("position: "), i(1), t(";") }),
	s("por", { t("position: relative;") }),
	s("poa", { t("position: absolute;") }),
	s("d ", { t("display: "), i(1), t(";") }),
	s("dn", { t("display: none;") }),
	s("m ", { t("margin: "), i(1), t(";") }),
	s("mt", { t("margin-top: "), i(1), t(";") }),
	s("mb", { t("margin-bottom: "), i(1), t(";") }),
	s("ml", { t("margin-left: "), i(1), t(";") }),
	s("mr", { t("margin-right: "), i(1), t(";") }),
	s("pt", { t("padding-top: "), i(1), t(";") }),
	s("pb", { t("padding-bottom: "), i(1), t(";") }),
	s("pl ", { t("padding-left: "), i(1), t(";") }),
	s("pr ", { t("padding-right: "), i(1), t(";") }),
	s("p,", { t("padding: "), i(1), t(";") }),
	s("pi ", { t("padding-inline: "), i(1), t(";") }),
	s("rds", { t("border-radius: "), i(1), t(";") }),
	s("g ", { t("gap: "), i(1), t(";") }),
	s("gtc", { t("grid-template-columns: "), i(1), t(";") }),
	s("f1", { t("flex: 1;") }),
	s("fs0", { t("flex-shrink: 0;") }),
	s("fg1", { t("flex-grow: 0;") }),
	s("g5", { t("gap: 0.5rem;") }),
	s("g1", { t("gap: 1rem;") }),
	s("g7", { t("gap: 0.75rem;") }),
	s("g2", { t("gap: 0.25rem;") }),
	s("fz", { t("font-size: "), i(1), t(";") }),
	s("fw", { t("font-weight: "), i(1), t(";") }),
	s("bd", { t("border: 1px solid "), i(1), t(";") }),
	s("df", { t("display: flex;") }),
	s("dg", { t("display: grid;") }),
	s("aic", { t("align-items: center;") }),
	s("afs", { t("align-items: flex-start;") }),
	s("afe", { t("align-items: flex-end;") }),
	s("jcc", { t("justify-content: center;") }),
	s("jsb", { t("justify-content: space-between;") }),
	s("jfs", { t("justify-content: flex-start;") }),
	s("jfe", { t("justify-content: flex-end;") }),
	s("fdc", { t("flex-direction: column;") }),
	s("vr", { t("var(--"), i(1), t(")") }),
	s("cv", { t("color: var(--"), i(1), t(");") }),
	s("bc", { t("background-color: "), i(1), t(";") }),
	s("bv", { t("background-color: var(--"), i(1), t(");") }),
	s("b1", { t("border: 1px solid var(--neutral-200);") }),
	s("t0", { t("top: 0;") }),
	s("b0", { t("bottom: 0;") }),
	s("l0", { t("left: 0;") }),
	s("r0", { t("right: 0;") }),
	s("i0", { t("top:0;right:0;bottom:0;left:0;") }),
}
