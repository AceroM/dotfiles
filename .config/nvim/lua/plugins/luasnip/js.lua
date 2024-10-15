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
	s(
		{ trig = "rus ", name = "useState" },
		fmt("const [{}, set{setter}] = React.useState{}({})", {
			i(1, "value"),
			i(0),
			i(2, "{InitialValue}"),
			setter = l(l._1:sub(1, 1):upper() .. l._1:sub(2, -1), { 1, 2 }),
		})
	),
	s("ar,", { t("() => {"), t({ "", "  " }), i(1), t({ "", "}" }) }),
	s("ac,", { t("async () => {"), t({ "", "  " }), i(1), t({ "", "}" }) }),
	s("ah,", { t("async (c) => {"), t({ "", "  " }), i(1), t({ "", "}" }) }),
	s("aw ", { t("await ", i(1)) }),
	s("ac ", { t("async ") }),
	s("cc ", {
		t("console.log('"),
		f(clipboard),
		t(" :>>', "),
		f(clipboard),
		t(");"),
	}),
	s("lj ", { t("console.log("), i(1), t(");") }),
	s("r2", { t("return res.status(200).send("), i(1), t(");") }),
	s("rq ", { t("require('"), i(1), t("')") }),
	s("jstr", { t("JSON.stringify("), i(1), t(")") }),
	s("jpar", { t("JSON.parse("), i(1), t(")") }),
	s("jstn", { t("JSON.stringify("), i(1), t(", null, 2)") }),
	s("dq", { t('"'), i(1), t('": "'), i(2), t('",') }),
	s(",/", { t("<"), i(1), t(" />") }),
	s("onp", { t("onPress={() => "), i(1), t({ "})" }) }),
	s("S ", { t("<Select>"), i(1), t("</Select>") }),
	s("B ", { t("<Button>"), i(1), t("</Button>") }),
	s("H ", { t("<Heading>"), i(1), t("</Heading>") }),
	s("M ", { t("<Modal>"), i(1), t("</Modal>") }),
	s("D ", { t("<Dialog>"), i(1), t("</Dialog>") }),
	s("csg", {
		t('createServerFn("GET", async () => {'),
		t({ "", "  await useUser()", "  " }),
		i(1),
		t({ "", "})" }),
	}),
	s("csp", {
		t('createServerFn("POST", async () => {'),
		t({ "", "  await useUser()", "  " }),
		i(1),
		t({ "", "})" }),
	}),
	s("tne", { t("throw new Error("), i(1), t(")") }),
	s("rcn", {
		t("function "),
		i(1),
		t("({"),
		t({ "", "  className,", "  ...props" }),
		t('}: React.ComponentPropsWithoutRef<"div">) {'),
		t({ "", "  return (" }),
		t({ "", '    <div {...props} className={cn(className, "' }),
		i(2),
		t({ '")} />' }),
		t({ "", "  );" }),
		t({ "", "}" }),
	}),
	s("ex ", { t("export ") }),
	s("ehe ", {
		t("export const "),
		i(1),
		t(": Handler = async (event) => {"),
		t({ "", "\t" }),
		i(2),
		t({ "", "}" }),
	}),
	s("eh ", { t("export const "), i(1), t(": Handler = async () => {"), t({ "", "\t" }), i(2), t({ "", "}" }) }),
	s("r=", { t("rules={{required: true}}") }),
	s("ons=", { t("onSubmit = React.useCallback(handleSubmit((data) => mutate(data)), [])") }),
	s("os=", { t("onSubmit={onSubmit}") }),
	s("oc=", { t("onClose={onClose}") }),
	s("uft", { t("const { control, handleSubmit, formState: { errors } } = useForm<any>()") }),
	s("ia ", { t("inArray("), i(1), t(")") }),
	s("rfs", { t("fs.readFileSync("), i(1), t(")") }),
	s("wfs", { t("fs.writeFileSync("), i(1), t(")") }),
	s("int ", { t("integration_connection") }),
	s("int.", { t("integration_connection.") }),
	s("int,", { t("integration_connection,") }),
	s("imm", { t("import * as R from 'remeda'") }),
	s("TT ", { t("<Tooltip>"), i(1), t("</Tooltip>") }),
	s("ise", { t("isError "), i(1) }),
	s("ah ", { t("ApiHandler(async (_evt) => {"), t({ "", "  " }), i(1), t({ "", "})" }) }),
	s("ldr", { t('<div className="ldr '), i(1), t('" />') }),
	s("ds ", { t("db.select("), i(1), t(")") }),
	s("sf ", { t("db.select().from("), i(1), t(")") }),
	s("di ", { t("db.insert("), i(1), t(")") }),
	s("du ", { t("db.update("), i(1), t(")") }),
	s("dd ", { t("db.delete("), i(1), t(")") }),
	s(".lj", { t(".leftJoin("), i(1), t(")") }),
	s(".rj", { t(".rightJoin("), i(1), t(")") }),
	s(".ij", { t(".innerJoin("), i(1), t(")") }),
	s(".fj", { t(".fullJoin("), i(1), t(")") }),
	s(".ob ", { t(".orderBy("), i(1), t(")") }),
	s(".obd ", { t(".orderBy(desc("), i(1), t("))") }),
	s(".oba ", { t(".orderBy(asc"), i(1), t("))") }),
	s(".l ", { t(".limit("), i(1), t(")") }),
	s(".f ", { t(".from("), i(1), t(")") }),
	s(".v ", { t(".values("), i(1), t(")") }),
	s(".s ", { t(".set({"), i(1), t("})") }),
	s(".w ", { t(".where("), i(1), t(")") }),
	s(".fr ", { t(".from("), i(1), t(")") }),
	s(".we ", { t(".where(eq("), i(1), t("))") }),
	s(".wa ", { t(".where(inArray("), i(1), t("))") }),
	s("ch ", { t("columnHelper.accessor("), i(1), t("),") }),
	s("ha-", { t("has-["), i(1), t("]") }),
	s("et ", { t("export type ") }),
	s("ei ", { t("export interface ") }),
	s("ed ", { t("export default "), i(1) }),
	s("tr ", { t("then((res) => res.data)") }),
	s("cln", { t("className") }),
	s("bn ", { t("<Button>"), i(1), t("</Button>") }),
	s("bs ", { t("<Button type='submit'>"), i(1), t("</Button>") }),
	s("rc ", { t("React.createContext("), i(1), t(")") }),
	s("ru ", { t("React.useContext("), i(1), t(")") }),
	s({ trig = "tc ", name = "try catch" }, fmt("try {{\n\t{}\n}} catch (err) {{\n\t\n}}", { i(0) })),
	s("vr", { t("var(--"), i(1), t(")") }),
	s("r ", { t("return ") }),
	s("tnr", { t("throw new RubyError("), i(1), t(")") }),
	s("pre,", { t("<pre>{JSON.stringify("), i(1), t(", null, 2)}</pre>") }),
	s("epd", { t("e.preventDefault()"), i(1) }),
	s("lh", { t("length "), i(1) }),
	s("isu", { t("isSuccess "), i(1) }),
	s("isl", { t("isLoading "), i(1) }),
	s("lgt", { i(1), t(".length > 0 "), i(2) }),
	s("llt", { i(1), t(".length < 0 "), i(2) }),
	s("leq", { i(1), t(".length === 0 "), i(2) }),
	s({ trig = "uc ", name = "useCallback" }, fmt("React.useCallback(({}) => {}, [])", { i(1), i(2) })),
	s({ trig = "um ", name = "useMemo" }, fmt("React.useMemo(() => {}, [{}])", { i(1), i(2) })),
	s("ue ", { t("React.useEffect(() => {"), t({ "", "  " }), i(2), t({ "", "}, [" }), i(1), t({ "])" }) }),
	s("ur ", { t("React.useRef("), i(1), t(")") }),
	s("ud ", { t("React.useReducer("), i(1), t(")") }),
	s("aia", { t("Array.isArray("), i(1), t(")") }),
	s("uv ", { t("utility.validate("), i(1), t(")") }),
	s("er ", { t("exports."), i(1), t(" = async (req, res) => {"), t({ "", "  " }), i(2), t({ "", "}" }) }),
	s("cb ", { t("const ["), i(1), t("] = "), i(2) }),
	s("cd ", { t("const { "), i(1), t(" } = "), i(2) }),
	s("ts/", { t("// @ts-ignore") }),
	s(";9", { t(": () => {"), t({ "", "  " }), i(1), t({ "", "}," }) }),
	s(";,", { t(": {"), t({ "", "  " }), i(1), t({ "", "}," }) }),
	s(".tis", { t(".toISOString()") }),
	s("fro ", { t("for (const "), i(2), t(" of "), i(1), t(") {"), t({ "", "  " }), i(3), t({ "", "}" }) }),
	s("ojv", { t("Object.values("), i(1), t(")") }),
	s("ojk", { t("Object.keys("), i(1), t(")") }),
	s("oje", { t("Object.entries("), i(1), t(")") }),
	s("imf", { t('import { motion } from "framer-motion"') }),
	s("imi", { t('import { Text } from "components"') }),
	s(
		{ trig = "frl", name = "for loop" },
		fmt("for (let {} = 0; {} < {}; {}++)", {
			i(1, "key"),
			l(l._1, 1),
			i(2, "value"),
			l(l._1, 1),
		})
	),
	s(
		{ trig = "imc", name = "import React Component" },
		fmt("import * as {} from 'components/{}'", {
			i(1, "value"),
			l(l._1:gsub("([a-z])([A-Z])", "%1-%2"):lower(), { 1 }),
		})
	),
	s(
		{ trig = "jk", name = "React Tag <>" },
		fmt("<{}>{}</{}>", {
			i(1, "div"),
			i(2),
			l(l._1, 1),
		})
	),
	s("imr", { t("import * as React from 'react'") }),
	s("ds=", { t('data-slot="'), i(1), t('"') }),
	s("ds-", { t("data-[slot="), i(1), t("]:"), i(2) }),
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
	s("imu", { t("import { "), i(1), t(' } from "ui";') }),
	s("eaf ", { t("export async function "), i(1), t("() {"), t({ "", "}" }) }),
	s("ef ", { t("export function "), i(1), t("() {"), t({ "", "}" }) }),
	s("ec ", { t("export const ") }),
	s("edf ", { t("export default function "), i(1), t("() {"), t({ "}" }) }),
	s("fn ", { t("function "), i(1), t({ "() {", "}" }) }),
	s("asf ", { t("async function "), i(1), t({ "() {", "}" }) }),
	s("pnv", { t("process.env.") }),
	s("rns", t("const styles = StyleSheet.create({"), i(1), t({ "  ", "});" })),
	s("oc ", { t("onClick={() => "), i(1), t({ "}" }) }),
	s("ocl", { t("onClick={("), i(1), t({ ") => {", "  " }), i(2), t({ "", "}}" }) }),
	s("s,.", { t("style={styles."), i(1), t("}") }),
	s("fd:", { t("flexDirection: "), i(1), t(";") }),
	s("jc:", { t("justifyContent: "), i(1), t(";") }),
	s("ai:", { t("alignItems: "), i(1), t(";") }),
	s(";l", { t(": {"), i(1), t("},") }),
	s("g:", { t("gap: "), i(1), t(";") }),
	s("c=", { t('className="'), i(1), t('"') }),
	s("fi ", { t("if ("), i(1), t(") {"), t({ "", "  " }), i(2), t({ "", "}" }) }),
	s("fil ", { t("if ("), i(1), t(".length "), i(2), t({ ") {" }), t({ "", "}" }) }),
	s("rfn", {
		t("export function "),
		f(function(args, snip)
			local filename = snip.env.TM_FILENAME_BASE or ""
			local words = {}
			for word in filename:gmatch("[^-]+") do
				table.insert(words, word:sub(1, 1):upper() .. word:sub(2))
			end
			return table.concat(words)
		end, {}),
		t("() {"),
		t({ "", "  return " }),
		i(1),
		t({ "", "}" }),
	}),
	s("m(", { t("map(("), i(1), t(") => ("), t({ "", "  " }), i(2), t({ "", "))" }) }),
	s("m{", { t("map(("), i(1), t(") => {"), t({ "", "  " }), i(2), t({ "", "})" }) }),
	s("f(", { t("filter(("), i(1), t(") => ("), t({ "", "  " }), i(2), t({ "", "))" }) }),
	s("f{", { t("filter(("), i(1), t(") => {"), t({ "", "  " }), i(2), t({ "", "})" }) }),
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
	s("tbl", { t({ '<table className="table">', "  " }), i(1), t({ "", "</table>" }) }),
	s("sl,", { t({ '<select className="select" ' }), i(1), t({ ">", "</select>" }) }),
	s("op,", { t('<option value="'), i(1), t('">'), i(2), t("</option>") }),
	s("d.", { t('<div className="'), i(1), t('">'), i(2), t("</div>") }),
	s("f.", { t('<form className="'), i(1), t('">'), i(2), t("</form>") }),
	s("b.", { t('<button className="'), i(1), t('">'), i(2), t("</button>") }),
	s("s.", { t('<span className="'), i(1), t('">'), i(2), t("</span>") }),
	s("p.", { t('<p className="'), i(1), t('">'), i(2), t("</p>") }),
	s("V ", { t({ "<View>", "  " }), i(1), t({ "", "</View>" }) }),
	s("V.", { t("<View style={styles."), i(1), t("}>"), i(2), t("</View>") }),
	s("T.", { t("<Text style={styles."), i(1), t("}>"), i(2), t("</Text>") }),
	s("c ", { t("const "), i(1) }),
	s("l ", { t("let "), i(1) }),
	s("och", { t("onChange") }),
	s("em ", { t("export module "), i(1), t(" {"), t({ "", "\t" }), i(2), t({ "", "}" }) }),
}
