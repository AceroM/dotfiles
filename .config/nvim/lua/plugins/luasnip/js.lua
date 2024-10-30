local ls = require("luasnip")
local s = ls.snippet
local f = ls.function_node
local t = ls.text_node
local i = ls.insert_node
local fmt = require("luasnip.extras.fmt").fmt
local extras = require("luasnip.extras")
local l = extras.lambda
local function return_filename(args, parent)
	return vim.fn.expand("%:t:r")
end
local function clipboard()
	return vim.fn.getreg("+")
end

return {
	s("fn;", { f(return_filename) }),
	s("fb;", {
		f(function(args, snip)
			local filename = snip.env.TM_FILENAME_BASE or ""
			local words = {}
			for word in filename:gmatch("[^-]+") do
				table.insert(words, word:sub(1, 1):upper() .. word:sub(2))
			end
			return table.concat(words)
		end, {}),
	}),
	s(
		{ trig = "rt;", name = "React Tag <>" },
		fmt("<{}>{}</{}>", {
			i(1, "div"),
			i(2),
			l(l._1, 1),
		})
	),
	s(
		{ trig = "j;", name = "React Tag with props <>" },
		fmt("<{} {}>{}</{}>", {
			i(1, "div"),
			i(2),
			i(3),
			l(l._1, 1),
		})
	),
	s(
		{ trig = "uqs;", name = "useQueryState" },
		fmt("const [{}, set{setter}] = useQueryState{}('{}')", {
			i(1, "value"),
			i(0),
			i(2),
			setter = l(l._1:sub(1, 1):upper() .. l._1:sub(2, -1), { 1, 2 }),
		})
	),
	s(
		{ trig = "rus;", name = "useState" },
		fmt("const [{}, set{setter}] = React.useState{}({})", {
			i(1, "value"),
			i(0),
			i(2, "{InitialValue}"),
			setter = l(l._1:sub(1, 1):upper() .. l._1:sub(2, -1), { 1, 2 }),
		})
	),
	s(
		{ trig = "imd", name = "import as" },
		fmt('import * as {} from "{}"', {
			i(1, "value"),
			l(l._1:gsub("([a-z])([A-Z])", "%1-%2"):lower(), { 1 }),
		})
	),
	s(
		{ trig = "imx", name = "import Radix UI Components" },
		fmt('import * as {} from "@radix-ui/react-{}"', {
			i(1, "value"),
			l(l._1:gsub("([a-z])([A-Z])", "%1-%2"):lower(), { 1 }),
		})
	),
	s("uc;", { t('"use client";') }),
	s("us;", { t('"use server";') }),
	s("uh;", { t('"use cache";') }),
	s("vc'", { t('varchar("'), i(1), t('", { length: 255 })') }),
	s("os=", { t("onSubmit={"), i(1), t("}") }),
	s("oc=", { t("onClick={"), i(1), t("}") }),
	s("s'", { t('size="'), i(1), t('"') }),
	s("ar,", { t("() => {"), t({ "", "  " }), i(1), t({ "", "}" }) }),
	s("ac;", { t("async ("), i(1), t(") => {"), t({ "", "}" }) }),
	s("aw ", { t("await ", i(1)) }),
	s("ac ", { t("async ") }),
	s("r.", { t("React.") }),
	s("c:", { t("console.log('"), f(clipboard), t(" :>>', "), f(clipboard), t(");") }),
	s("c(", { t("console.log("), i(1) }),
	s("r2", { t("return res.status(200).send("), i(1), t(");") }),
	s("r(", { t("require("), i(1), t('"') }),
	s("va(", { t("validatedAction("), i(1) }),
	s("js;", { t("JSON.stringify("), i(1), t(")") }),
	s("jp;", { t("JSON.parse("), i(1), t(")") }),
	s("j2;", { t("JSON.stringify("), i(1), t(", null, 2)") }),
	s(",/", { t("<"), i(1), t(" />") }),
	s("op=", { t("onPress={() => "), i(1), t({ "})" }) }),
	s("te'", { t("throw new Error("), i(1), t(")") }),
	s("ex ", { t("export ") }),
	s("r=", { t("rules={{"), i(1), t("}}") }),
	s("os=", { t("onSubmit={onSubmit}") }),
	s("oc=", { t("onClose={onClose}") }),
	s("fsr;", { t("fs.readFileSync("), i(1), t(")") }),
	s("fsw;", { t("fs.writeFileSync("), i(1), t(")") }),
	s("i(", { t("insert("), i(1) }),
	s("fr(", { t("from("), i(1) }),
	s("u(", { t("update("), i(1) }),
	s("v(", { t("values("), i(1) }),
	s("s(", { t("select("), i(1) }),
	s("se(", { t("set("), i(1) }),
	s("d(", { t("delete("), i(1) }),
	s("w(", { t("where("), i(1) }),
	s("e(", { t("eq("), i(1) }),
	s("a(", { t("and("), i(1) }),
	s("l(", { t("limit("), i(1) }),
	s("ia(", { t("inArray("), i(1) }),
	s("nn(", { t("notNull("), i(1) }),
	s("lj(", { t("leftJoin("), i(1) }),
	s("rj(", { t("rightJoin("), i(1) }),
	s("ij(", { t("innerJoin("), i(1) }),
	s("fj(", { t("fullJoin("), i(1) }),
	s("o(", { t("orderBy("), i(1), t(")") }),
	s("ch(", { t("columnHelper.accessor("), i(1) }),
	s("ha-", { t("has-["), i(1), t("]") }),
	s("et ", { t("export type ") }),
	s("ei ", { t("export interface ") }),
	s("ed ", { t("export default "), i(1) }),
	s("cln", { t("className") }),
	s("rcc;", { t("React.createContext("), i(1), t(")") }),
	s("ruc;", { t("React.useContext("), i(1), t(")") }),
	s({ trig = "tc;", name = "try catch" }, fmt("try {{\n\t{}\n}} catch (err) {{\n\t\n}}", { i(0) })),
	s("r ", { t("return ") }),
	s("tnr", { t("throw new RubyError("), i(1), t(")") }),
	s("pre,", { t("<pre>{JSON.stringify("), i(1), t(", null, 2)}</pre>") }),
	s("epd", { t("e.preventDefault()"), i(1) }),
	s("l=", { t("length === "), i(1) }),
	s("l ", { t("length "), i(1) }),
	s("is;", { t("isSuccess"), i(1) }),
	s("il;", { t("isLoading"), i(1) }),
	s("ise", { t("isError "), i(1) }),
	s({ trig = "ruc;", name = "useCallback" }, fmt("React.useCallback(({}) => {}, [])", { i(1), i(2) })),
	s({ trig = "rum;", name = "useMemo" }, fmt("React.useMemo(() => {}, [{}])", { i(1), i(2) })),
	s("rue;", { t("React.useEffect(() => {"), t({ "", "  " }), i(2), t({ "", "}, [" }), i(1), t({ "])" }) }),
	s("ras;", { t("React.useActionState("), i(1), t(")") }),
	s("rur;", { t("React.useRef("), i(1), t(")") }),
	s("rud;", { t("React.useReducer("), i(1), t(")") }),
	s("ai(", { t("Array.isArray("), i(1) }),
	s("e.", { t("exports."), i(1), t(" = async (req, res) => {"), t({ "", "  " }), i(2), t({ "", "}" }) }),
	s("cb ", { t("const ["), i(1), t("] = "), i(2) }),
	s("cd ", { t("const { "), i(1), t(" } = "), i(2) }),
	s("ts/", { t("// @ts-ignore") }),
	s("tis;", { t("toISOString()") }),
	s("f(", { t("for ("), i(1) }),
	s("ov(", { t("Object.values("), i(1) }),
	s("ok(", { t("Object.keys("), i(1) }),
	s("oe(", { t("Object.entries("), i(1) }),
	s("im;", { t('import { motion } from "framer-motion"') }),
	s("ij;", { t('import dayjs from "dayjs"') }),
	s("id;", { t('import { eq } from "drizzle-orm"') }),
	s("iz;", { t('import { z } from "zod"') }),
	s("il;", { t('import { Link } from "@tanstack/react-router"') }),
	s("iu;", { t("import { "), i(1), t(' } from "ui";') }),
	s("ir;", { t("import * as React from 'react'") }),
	s("ds=", { t('data-slot="'), i(1), t('"') }),
	s("ds-", { t("data-[slot="), i(1), t("]:"), i(2) }),
	s("eaf;", { t("export async function "), i(1), t("() {"), t({ "", "}" }) }),
	s("edf;", { t("export default function "), i(1), t("() {"), t({ "", "}" }) }),
	s("edaf;", { t("export default async function "), i(1), t("() {"), t({ "", "}" }) }),
	s("ef;", { t("export function "), i(1), t("() {"), t({ "", "}" }) }),
	s("ec ", { t("export const ") }),
	s("f;", { t("function "), i(1), t({ "() {", "}" }) }),
	s("af;", { t("async function "), i(1), t({ "() {", "}" }) }),
	s("pv.", { t("process.env.") }),
	s("rs;", t("const styles = StyleSheet.create({"), i(1), t({ "  ", "});" })),
	s("oc;", { t("onClick={("), i(1), t({ ") => {", "  " }), i(2), t({ "", "}}" }) }),
	s("s,.", { t("style={styles."), i(1), t("}") }),
	s("fd:", { t("flexDirection: "), i(1), t(";") }),
	s("jc:", { t("justifyContent: "), i(1), t(";") }),
	s("ai:", { t("alignItems: "), i(1), t(";") }),
	s(";l", { t(": {"), i(1), t("},") }),
	s("g:", { t("gap: "), i(1), t(";") }),
	s("c=", { t('className="'), i(1), t('"') }),
	s("v=", { t('value="'), i(1), t('"') }),
	s("v{", { t("value={"), i(1) }),
	s("vr=", { t('variant="'), i(1), t('"') }),
	s("c{", { t("className={"), i(1), t("") }),
	s("if(", { t("if ("), i(1), t(") {"), t({ "", "  " }), i(2), t({ "", "}" }) }),
	s("m(", { t("map(("), i(1), t(") => ("), t({ "", "  " }), i(2), t({ "", ")" }) }),
	s("m{", { t("map(("), i(1), t(") => {"), t({ "", "  " }), i(2), t({ "", ")" }) }),
	s("fl(", { t("filter(("), i(1), t(") => ("), t({ "", "  " }), i(2), t({ "", ")" }) }),
	s("fl{", { t("filter(("), i(1), t(") => {"), t({ "", "  " }), i(2), t({ "", ")" }) }),
	s("t(", { t("then(("), i(1), t(") => ("), t({ "", "  " }), i(2), t({ "", "))" }) }),
	s("t{", { t("then(("), i(1), t(") => {"), t({ "", "  " }), i(2), t({ "", "})" }) }),
	s("tr.", { t('<tr className="'), i(1), t('">'), i(2), t("</tr>") }),
	s("th.", { t('<th className="'), i(1), t('">'), i(2), t("</th>") }),
	s("td.", { t('<td className="'), i(1), t('">'), i(2), t("</td>") }),
	s("h1.", { t('<h1 className="'), i(1), t('">'), i(2), t("</h1>") }),
	s("h2.", { t('<h2 className="'), i(1), t('">'), i(2), t("</h2>") }),
	s("h3.", { t('<h3 className="'), i(1), t('">'), i(2), t("</h3>") }),
	s("h4.", { t('<h4 className="'), i(1), t('">'), i(2), t("</h4>") }),
	s("ul.", { t('<ul className="'), i(1), t('">'), i(2), t("</ul>") }),
	s("li.", { t('<li className="'), i(1), t('">'), i(2), t("</li>") }),
	s("it.", { t('<input type="text" className="'), i(1), t('" />') }),
	s("l,", { t('<label className="label" htmlFor="'), i(1), t('">'), i(2), t("</label>") }),
	s("op,", { t('<option value="'), i(1), t('">'), i(2), t("</option>") }),
	s("d.", { t('<div className="'), i(1), t('">'), i(2), t("</div>") }),
	s("f.", { t('<form className="'), i(1), t('">'), i(2), t("</form>") }),
	s("b.", { t('<button className="'), i(1), t('">'), i(2), t("</button>") }),
	s("s.", { t('<span className="'), i(1), t('">'), i(2), t("</span>") }),
	s("p.", { t('<p className="'), i(1), t('">'), i(2), t("</p>") }),
	s("V;", { t({ "<View>", "  " }), i(1), t({ "", "</View>" }) }),
	s("V.", { t("<View style={styles."), i(1), t("}>"), i(2), t("</View>") }),
	s("T.", { t("<Text style={styles."), i(1), t("}>"), i(2), t("</Text>") }),
	s("c ", { t("const "), i(1) }),
	s("l ", { t("let "), i(1) }),
	s("em ", { t("export module "), i(1), t(" {"), t({ "", "\t" }), i(2), t({ "", "}" }) }),
}
