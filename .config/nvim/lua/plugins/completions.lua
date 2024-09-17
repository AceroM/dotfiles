return {
	{
		"hrsh7th/cmp-nvim-lsp",
	},
	{
		"windwp/nvim-autopairs",
		event = "InsertEnter",
		config = true,
	},
	{
		"L3MON4D3/LuaSnip",
		dependencies = {
			"saadparwaiz1/cmp_luasnip",
			"rafamadriz/friendly-snippets",
		},
		config = function()
			local function return_filename(args, parent)
				local filename = vim.fn.expand("%:t:r")
				return filename
			end
			local ls = require("luasnip")
			local s = ls.snippet
			local f = ls.function_node
			local t = ls.text_node
			local i = ls.insert_node
			local extras = require("luasnip.extras")
			local l = extras.lambda
			local fmt = require("luasnip.extras.fmt").fmt
			local function clipboard()
				return vim.fn.getreg("+")
			end
			vim.keymap.set({ "i" }, "<C-K>", function()
				ls.expand()
			end, { silent = true })
			vim.keymap.set({ "i", "s" }, "<C-L>", function()
				ls.jump(1)
			end, { silent = true })
			vim.keymap.set({ "i", "s" }, "<C-J>", function()
				ls.jump(-1)
			end, { silent = true })
			vim.keymap.set({ "i", "s" }, "<C-E>", function()
				if ls.choice_active() then
					ls.change_choice(1)
				end
			end, { silent = true })
			ls.config.setup({ enable_autosnippets = true })
			ls.add_snippets("all", {
				s("dq", { t('"'), i(1), t('": "'), i(2), t('",') }),
				s(",/", { t("<"), i(1), t(" />") }),
				s("l8", { t("http://localhost:8080") }),
				s("l3", { t("http://localhost:3000") }),
				s("cj,", { t("content-type: application/json") }),
				s("aj,", { t("accept: application/json") }),
				s("aa,", { t("authorization: {{AUTH}}") }),
				s("mgm", { t("miguelacero528@gmail.com") }),
				-- s("m,", { t("{% "), i(1), t(" /%}") }),
				s("jstr", { t("JSON.stringify("), i(1), t(")") }),
				s("jpar", { t("JSON.parse("), i(1), t(")") }),
				s("jstn", { t("JSON.stringify("), i(1), t(", null, 2)") }),
				s("rq ", { t("require('"), i(1), t("')") }),
				s("r2", { t("return res.status(200).send("), i(1), t(");") }),
				s("dr ", { t("debugger") }),
				s("lj ", { t("console.log("), i(1), t(");") }),
				s("cc ", {
					t("console.log('"),
					f(clipboard),
					t(" :>>', "),
					f(clipboard),
					t(");"),
				}),
				s("aw ", { t("await ", i(1)) }),
				s("ac ", { t("async ") }),
				s("ar,", { t("() => {"), t({ "", "  " }), i(1), t({ "", "}" }) }),
				s("ac,", { t("async () => {"), t({ "", "  " }), i(1), t({ "", "}" }) }),
				s("ah,", { t("async (c) => {"), t({ "", "  " }), i(1), t({ "", "}" }) }),
				s(
					{ trig = "rus ", name = "useState" },
					fmt("const [{}, set{setter}] = React.useState{}({})", {
						i(1, "value"),
						i(0),
						i(2, "{InitialValue}"),
						setter = l(l._1:sub(1, 1):upper() .. l._1:sub(2, -1), { 1, 2 }),
					})
				),
				s("hl,", { t("<html>"), i(1), t("</html>") }),
				s("hd,", { t("<head>"), i(1), t("</head>") }),
				s("bd,", { t("<body>"), i(1), t("</body>") }),
				s("tit,", { t("<title>"), i(1), t("</title>") }),
				s("mt,", { t("<meta "), i(1), t(" />") }),
				s("at,", { t("<link "), i(1), t(" />") }),
				s("scr,", { t("<script>"), i(1), t("</script>") }),
				s("sty,", { t("<style>"), i(1), t("</style>") }),
				s("sec,", { t("<section>"), i(1), t("</section>") }),
				s("art,", { t("<article>"), i(1), t("</article>") }),
				s("nv,", { t("<nav>"), i(1), t("</nav>") }),
				s("asd,", { t("<aside>"), i(1), t("</aside>") }),
				s("hdr,", { t("<header>"), i(1), t("</header>") }),
				s("ftr,", { t("<footer>"), i(1), t("</footer>") }),
				s("tbd", { t({ "<tbody>", "  " }), i(1), t({ "", "</tbody>" }) }),
				s("tbf", { t({ "<tfoot>", "  " }), i(1), t({ "", "</tfoot>" }) }),
				s("thd", { t({ "<thead>", "  " }), i(1), t({ "", "</thead>" }) }),
				s("tr,", { t({ "<tr>", "  " }), i(1), t({ "", "</tr>" }) }),
				s("th,", { t("<th>"), i(1), t("</th>") }),
				s("td,", { t("<td>"), i(1), t("</td>") }),
				s("h1,", { t("<h1>"), i(1), t("</h1>") }),
				s("h2,", { t("<h2>"), i(1), t("</h2>") }),
				s("h3,", { t("<h3>"), i(1), t("</h3>") }),
				s("h4,", { t("<h4>"), i(1), t("</h4>") }),
				s("d,", { t("<div>"), i(1), t("</div>") }),
				s("dl,", { t("<dl>"), i(1), t("</dl>") }),
				s("dt,", { t("<dt>"), i(1), t("</dt>") }),
				s("dd,", { t("<dd>"), i(1), t("</dd>") }),
				s("s,", { t("<span>"), i(1), t("</span>") }),
				s("b,", { t("<button>"), i(1), t("</button>") }),
				s("b,", { t("<form>"), i(1), t("</form>") }),
				s("u,", { t("<ul>"), i(1), t("</ul>") }),
				s("p,", { t("<p>"), i(1), t("</p>") }),
				s("li,", { t("<li>"), i(1), t("</li>") }),
				s("f,", { t("<form>"), i(1), t("</form>") }),
				s("main,", { t("<main>"), i(1), t("</main>") }),
				s("ul,", { t("<ul>"), i(1), t("</ul>") }),
				s("ipt", { t('<input type="text" '), i(1), t(" />") }),
				s("ipc", { t('<input type="checkbox" '), i(1), t(" />") }),
				s("ipn", { t('<input type="number" '), i(1), t(" />") }),
				s("ipe", { t('<input type="email" '), i(1), t(" />") }),
				s("imt", { t('<img src="'), i(1), t('" alt="'), i(2), t('"/>') }),
				s("at,", { t('<a href="'), i(1), t('"/>') }),
			}, {
				autotrigger = true,
				type = "autosnippets",
				key = "all",
				priority = 9999,
			})
			ls.add_snippets("lua", {
				s("r ", { t("return ") }),
				s("cf ", { t("config = function()"), t({ "", "  " }), i(1), t({ "", "end" }) }),
			}, {
				autotrigger = true,
				type = "autosnippets",
				key = "lua",
				priority = 9999,
			})
			local js_snippets = {
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
				s("bk ", { t("block") }),
				s("hd ", { t("hidden") }),
				s("mlg", { t("max-lg:") }),
				s("ex ", { t("export ") }),
				s("ehe ", {
					t("export const "),
					i(1),
					t(": Handler = async (event) => {"),
					t({ "", "\t" }),
					i(2),
					t({ "", "}" }),
				}),
				s(
					"eh ",
					{ t("export const "), i(1), t(": Handler = async () => {"), t({ "", "\t" }), i(2), t({ "", "}" }) }
				),
				s("FC ", {
					t("<Controller"),
					t({ "", ' name="' }),
					i(1),
					t({ '"' }),
					t({ "", "control={control} rules={{required: true}} render={({field}) => (" }),
					i(2),
					t(")} />"),
				}),
				s("r=", { t("rules={{required: true}}") }),
				s("c=", { t("control={control}") }),
				s("IF ", {
					t('<Input type="'),
					i(1),
					t('" control={control} name="'),
					i(2),
					t('" rules={{required: true}} placeholder="'),
					i(3),
					t('" />'),
				}),
				s("tru ", { t("truncate") }),
				s("ons=", { t("onSubmit = React.useCallback(handleSubmit((data) => mutate(data)), [])") }),
				s("os=", { t("onSubmit={onSubmit}") }),
				s("oc=", { t("onClose={onClose}") }),
				s("uft", { t("const { control, handleSubmit, formState: { errors } } = useForm<any>()") }),
				s("g-", { t("gap-") }),
				s("wsn", { t("whitespace-nowrap") }),
				s("ia ", { t("inArray("), i(1), t(")") }),
				s("rfs", { t("fs.readFileSync("), i(1), t(")") }),
				s("wfs", { t("fs.writeFileSync("), i(1), t(")") }),
				s("int ", { t("integration_connection") }),
				s("int.", { t("integration_connection.") }),
				s("int,", { t("integration_connection,") }),
				s("imm", { t("import * as R from 'remeda'") }),
				s("TT ", { t("<Tooltip>"), i(1), t("</Tooltip>") }),
				s("cur ", { t("cursor-pointer") }),
				s("ise", { t("isError "), i(1) }),
				s("fr ", { t("flex-row") }),
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
				s("bt-", { t("border-t-"), i(1) }),
				s("bl-", { t("border-l-"), i(1) }),
				s("br-", { t("border-r-"), i(1) }),
				s("bb-", { t("border-b-"), i(1) }),
				s("ha-", { t("has-["), i(1), t("]") }),
				s("et ", { t("export type ") }),
				s("ei ", { t("export interface ") }),
				s("ed ", { t("export default "), i(1) }),
				s("oun", { t("outline-none") }),
				s("ws ", { t("w-screen") }),
				s("hs ", { t("h-screen") }),
				s("tz ", { t("transition") }),
				s("du-", { t("duration-") }),
				s("eio ", { t("ease-in-out") }),
				s("tx-", { t("translate-x-") }),
				s("ty-", { t("translate-y-") }),
				s("iy0", { t("inset-y-0") }),
				s("ix0", { t("inset-x-0") }),
				s("iyh", { t("inset-y-0") }),
				s("ixh", { t("inset-x-0") }),
				s("fd ", { t("fixed") }),
				s("pen ", { t("pointer-events-none") }),
				s("TBL", { t({ "<Table>" }), i(1), t({ "</Table>" }) }),
				s("TH ", { t({ "<TableHead>" }), i(1), t({ "</TableHead>" }) }),
				s("THR", { t({ "<TableHeader>" }), i(1), t({ "</TableHeader>" }) }),
				s("TB ", { t({ "<TableBody>" }), i(1), t({ "</TableBody>" }) }),
				s("TR ", { t({ "<TableRow>" }), i(1), t({ "</TableRow>" }) }),
				s("TC ", { t({ "<TableCell>" }), i(1), t({ "</TableCell>" }) }),
				s("C ", { t({ "<Card>" }), i(1), t({ "</Card>" }) }),
				s("C.", { t({ '<Card className="' }), i(1), t({ '">' }), i(2), t({ "</Card>" }) }),
				s("CH ", { t({ "<CardHeader>" }), i(1), t({ "</CardHeader>" }) }),
				s("CH.", { t({ '<CardHeader className="' }), i(1), t({ '">' }), i(2), t({ "</CardHeader>" }) }),
				s("CB ", { t({ "<CardBody>" }), i(1), t({ "</CardBody>" }) }),
				s("CB.", { t({ '<CardBody className="' }), i(1), t({ '">' }), i(2), t({ "</CardBody>" }) }),
				s("CF ", { t({ "<CardFooter>" }), i(1), t({ "</CardFooter>" }) }),
				s("CF.", { t({ '<CardFooter className="' }), i(1), t({ '">' }), i(2), t({ "</CardFooter>" }) }),
				s("CX ", { t({ "<Checkbox>" }), i(1), t({ "</Checkbox>" }) }),
				s("CG ", { t({ "<CheckboxGroup>" }), i(1), t({ "</CheckboxGroup>" }) }),
				s("CF ", { t({ "<CheckboxField>" }), i(1), t({ "</CheckboxField>" }) }),
				s("S ", { t({ "<Select>" }), i(1), t({ "</Select>" }) }),
				s("DS ", { t({ "<Description>" }), i(1), t({ "</Description>" }) }),
				s("DSL ", { t({ "<DescriptionList>" }), i(1), t({ "</DescriptionList>" }) }),
				s("DST ", { t({ "<DescriptionTerm>" }), i(1), t({ "</DescriptionTerm>" }) }),
				s("DSD ", { t({ "<DescriptionDetails>" }), i(1), t({ "</DetailsDetails>" }) }),
				s("EM ", { t({ "<ErrorMessage>" }), i(1), t({ "</ErrorMessage>" }) }),
				s("LE ", { t({ "<Legend>" }), i(1), t({ "</Legend>" }) }),
				s("I ", { t({ '<Input type="' }), i(1), t({ '" />' }) }),
				s("L ", { t({ '<Label htmlFor="' }), i(1), t({ '">' }), i(2), t({ "</Label>" }) }),
				s("LR ", { t({ '<Label htmlFor="' }), i(1), t({ '" required>' }), i(2), t({ "</Label>" }) }),
				s("F ", { t({ "<Field>" }), i(1), t({ "</Field>" }) }),
				s("FG ", { t({ "<FieldGroup>" }), i(1), t({ "</FieldGroup>" }) }),
				s("FS ", { t({ "<Fieldset>" }), i(1), t({ "</Fieldset>" }) }),
				s("P ", { t({ "<Popover>" }), i(1), t({ "</Popover>" }) }),
				s("PB ", { t({ "<PopoverButton>" }), i(1), t({ "</PopoverButton>" }) }),
				s("PP ", { t({ "<PopoverPanel>" }), i(1), t({ "</PopoverPanel>" }) }),
				s("D ", { t({ "<Dialog>" }), i(1), t({ "</Dialog>" }) }),
				s("DT ", { t({ "<DialogTitle>" }), i(1), t({ "</DialogTitle>" }) }),
				s("DD ", { t({ "<DialogDescription>" }), i(1), t({ "</DialogDescription>" }) }),
				s("DB ", { t({ "<DialogBody>" }), i(1), t({ "</DialogBody>" }) }),
				s("DC ", { t({ "<DialogClose onClose={" }), i(1), t({ "} />" }) }),
				s("DA ", { t({ "<DialogActions>" }), i(1), t({ "</DialogActions>" }) }),
				s("DW ", { t({ "<Drawer>" }), i(1), t({ "</Drawer>" }) }),
				s("DWH ", { t({ "<DrawerHeader>" }), i(1), t({ "</DrawerHeader>" }) }),
				s("SH ", { t({ "<Subheading>" }), i(1), t({ "</Subheading>" }) }),
				s("DWT ", { t({ "<DrawerTitle>" }), i(1), t({ "</DrawerTitle>" }) }),
				s("DWD ", { t({ "<DrawerDescription>" }), i(1), t({ "</DrawerDescription>" }) }),
				s("DWB ", { t({ "<DrawerBody>" }), i(1), t({ "</DrawerBody>" }) }),
				s("DWC ", { t({ "<DrawerClose />" }) }),
				s("DR ", { t({ "<Dropdown>" }), i(1), t({ "</Dropdown>" }) }),
				s("DRB ", { t({ "<DropdownButton>" }), i(1), t({ "</DropdownButton>" }) }),
				s("DM ", { t({ "<DropdownMenu>" }), i(1), t({ "</DropdownMenu>" }) }),
				s("DL ", { t({ "<DropdownLabel>" }), i(1), t({ "</DropdownLabel>" }) }),
				s("DI ", { t({ "<DropdownItem>" }), i(1), t({ "</DropdownItem>" }) }),
				s("DH ", { t({ "<DropdownHeader>" }), i(1), t({ "</DropdownHeader>" }) }),
				s("d-", { t("data-["), i(1), t("]:") }),
				s("r-", { t("ring-") }),
				s("sro", { t("sr-only") }),
				s("rg-", { t("ring-gray-") }),
				s("qc ", { t("const queryClient = useQueryClient()") }),
				s("rfl", { t("rounded-full") }),
				s("teb ", { t("text-base") }),
				s("tece", { t("text-center") }),
				s("T ", { t("<Text>"), i(1), t("</Text>") }),
				s("TL ", { t("<TextLink>"), i(1), t("</TextLink>") }),
				s("H ", { t("<Heading>"), i(1), t("</Heading>") }),
				s("B ", { t("<Button>"), i(1), t("</Button>") }),
				s("BA ", { t("<Badge>"), i(1), t("</Badge>") }),
				s("BB ", { t("<BadgeButton>"), i(1), t("</BadgeButton>") }),
				s("bob", { t("border-b") }),
				s("bor", { t("border-r") }),
				s("bol", { t("border-l") }),
				s("bot ", { t("border-t") }),
				s("wc", { t("w-fit") }),
				s("hc", { t("h-fit") }),
				s("tr ", { t("then((res) => res.data)") }),
				s("cln", { t("className") }),
				s("bn ", { t("<Button>"), i(1), t("</Button>") }),
				s("bno", { t("<Button outline>"), i(1), t("</Button>") }),
				s("bnl", { t("<Button large>"), i(1), t("</Button>") }),
				s("bns", { t("<Button small>"), i(1), t("</Button>") }),
				s("rc ", { t("React.createContext("), i(1), t(")") }),
				s("ru ", { t("React.useContext("), i(1), t(")") }),
				s("r.", { t("React.") }),
				s("op ", { t("opacity-") }),
				s("hc ", { t("has-[:checked]:") }),
				s("fo ", { t("focus:") }),
				s("ho ", { t("hover:") }),
				s({ trig = "tc ", name = "try catch" }, fmt("try {{\n\t{}\n}} catch (err) {{\n\t\n}}", { i(0) })),
				s(
					{ trig = "LB ", name = "listbox" },
					fmt("<Listbox value={{{}}} onChange={{{}}}>{}</Listbox>", { i(1), i(2), i(3) })
				),
				s(
					{ trig = "LBO ", name = "listbox option" },
					fmt("<ListboxOption key={{{}}} value={{{}}}>{}</ListboxOption>", { i(0), i(1), i(2) })
				),
				s("LBL ", { t("<ListboxLabel>"), i(1), t("</ListboxLabel>") }),
				s(
					{ trig = "cr ", name = "catch ruby error" },
					fmt("catch((err) => {{\n\tthrow new RubyError({}, {{ err }})\n}})", { i(0) })
				),
				s("sz", { t("size-") }),
				s("oj ", { t("object-") }),
				s("itl", { t("italic") }),
				s("fmd", { t("font-medium") }),
				s("fsb", { t("font-semibold") }),
				s("fbd", { t("font-bold") }),
				s("flt", { t("font-light") }),
				s("txs", { t("text-xs") }),
				s("tlg", { t("text-lg") }),
				s("tsm", { t("text-sm") }),
				s("txl", { t("text-xl") }),
				s("t2xl", { t("text-2xl") }),
				s("t3xl", { t("text-3xl") }),
				s("bd", { t("border") }),
				s("vr", { t("var(--"), i(1), t(")") }),
				s("l0", { t("left-0") }),
				s("r0", { t("right-0") }),
				s("t0", { t("top-0") }),
				s("b0", { t("bottom-0") }),
				s("i0", { t("inset-0") }),
				s("r ", { t("return ") }),
				s("rl ", { t("relative") }),
				s("ab ", { t("absolute") }),
				s("bgg", { t("bg-gray-") }),
				s("bgb", { t("bg-brand-") }),
				s("bgr", { t("bg-red-") }),
				s("bgy", { t("bg-yellow-") }),
				s("bgp", { t("bg-purple-") }),
				s("teg", { t("text-gray-") }),
				s("teb", { t("text-brand-") }),
				s("tnr", { t("throw new RubyError("), i(1), t(")") }),
				s("oya", { t("overflow-y-auto") }),
				s("oxa", { t("overflow-x-auto") }),
				s("oyh", { t("overflow-y-hidden") }),
				s("oxh", { t("overflow-x-hidden") }),
				s("f1", { t("flex-1") }),
				s("ovh", { t("overflow-hidden") }),
				s("rel ", { t("relative") }),
				s("sh ", { t("shadow-"), i(1) }),
				s("rmd", { t("rounded-md") }),
				s("rlg", { t("rounded-lg") }),
				s("bgw", { t("bg-white") }),
				s("tw ", { t("text-white") }),
				s("b-", { t("bg-"), i(1) }),
				s("t-", { t("text-"), i(1) }),
				s("df", { t("flex") }),
				s("g2", { t("gap-2") }),
				s("g4", { t("gap-4") }),
				s("gc-", { t("grid-cols-") }),
				s("gr-", { t("grid-rows-") }),
				s("cs-", { t("col-span-") }),
				s("mta ", { t("mt-auto") }),
				s("mba ", { t("mb-auto") }),
				s("mla", { t("ml-auto") }),
				s("mra", { t("mr-auto") }),
				s("mxa", { t("mx-auto") }),
				s("mah", { t("max-h-") }),
				s("mih", { t("min-h-") }),
				s("maw", { t("max-w-") }),
				s("jb ", { t("justify-between") }),
				s("fc ", { t("flex-col") }),
				s("jc ", { t("justify-center") }),
				s("js ", { t("justify-start") }),
				s("je ", { t("justify-end") }),
				s("its ", { t("items-start") }),
				s("ite ", { t("items-end") }),
				s("ic ", { t("items-center") }),
				s("spy", { t("space-y-") }),
				s("spx", { t("space-x-") }),
				s("wf", { t("w-full") }),
				s("hf", { t("h-full") }),
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
					{ trig = "m,", name = "React Tag <>" },
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
				s("cl ", { t('className="'), i(1), t('"') }),
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
				s(".m ", { t(".map("), i(1), t(" => "), i(2), t(")") }),
				s(".fl ", { t(".filter("), i(1), t(" => "), i(2), t(")") }),
				s(".t ", { t(".then("), i(1), t(" => "), i(2), t(")") }),
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
			ls.add_snippets("javascriptreact", js_snippets, {
				autotrigger = true,
				type = "autosnippets",
				key = "js_react",
				priority = 9999,
			})
			ls.add_snippets("typescriptreact", js_snippets, {
				autotrigger = true,
				type = "autosnippets",
				key = "ts_react",
				priority = 9999,
			})
			ls.add_snippets("javascript", js_snippets, {
				autotrigger = true,
				type = "autosnippets",
				key = "js",
				priority = 9999,
			})
			ls.add_snippets("typescript", js_snippets, {
				autotrigger = true,
				type = "autosnippets",
				key = "ts",
				priority = 9999,
			})
			ls.add_snippets("css", {
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
			}, {
				autotrigger = true,
				type = "autosnippets",
				key = "css",
				priority = 9999,
			})
			ls.add_snippets("ruby", {
				s("e;", { t("each do |"), i(1), t("|"), t({ "", "  " }), i(2), t({ "", "end" }) }),
				s("df", { t("do"), t({ "", "  " }), i(1), t({ "", "end" }) }),
				s("d;", { t("do |"), i(1), t("|"), t({ "", "  " }), i(2), t({ "", "end" }) }),
				s("rf ", { t("rescue_from ") }),
				s("rb ", { t("redirect_back ") }),
				s("rt ", { t("redirect_to ") }),
				s("c ", { t("class "), i(1), t({ "", "  end" }) }),
				s("m ", { t("module "), i(1), t({ "", "end" }) }),
				s("eac", { t("extend ActiveSupport::Concern") }),
				s("ind ", { t("included do"), t({ "", "  " }), i(1), t({ "", "end" }) }),
				s("ba ", { t("before_action :"), i(1) }),
				s("bt ", { t("belongs_to :"), i(1), t(", optional: true") }),
				s("aa ", { t("after_action :"), i(1) }),
				s("rd ", { t("render "), i(1) }),
				s("ri ", { t("render inertia: "), i(1) }),
				s("pv ", { t("private "), t({ "", "" }) }),
				s("fi ", { t("if "), i(1), t(" "), i(2), t({ "", "end" }) }),
				s("p ", { t("puts "), i(1) }),
				s("p'", { t('puts "'), i(1), t('"') }),
				s("fsl", { t("# frozen_string_literal: true") }),
				s("cu ", { t("current_user") }),
				s("ar ", { t("attr_reader :") }),
				s("ae ", { t("assert_equal ") }),
				s("d ", { t("def "), i(1), t({ "  ", "end" }) }),
				s("hm ", { t("has_many :"), i(1), t(", dependent: :destroy") }),
			}, {
				autotrigger = true,
				type = "autosnippets",
				key = "ruby",
				priority = 9999,
			})
			ls.add_snippets("eruby", {
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
			}, {
				autotrigger = true,
				type = "autosnippets",
				key = "eruby",
				priority = 9999,
			})
			ls.add_snippets("sql", {
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
			}, {
				autotrigger = true,
				type = "autosnippets",
				key = "sql",
				priority = 9999,
			})
		end,
	},
	{
		"hrsh7th/nvim-cmp",
		config = function()
			local cmp = require("cmp")
			require("luasnip.loaders.from_vscode").lazy_load()
			cmp.setup({
				snippet = {
					expand = function(args)
						require("luasnip").lsp_expand(args.body)
					end,
				},
				window = {
					completion = cmp.config.window.bordered(),
					documentation = cmp.config.window.bordered(),
				},
				mapping = cmp.mapping.preset.insert({
					["<C-b>"] = cmp.mapping.scroll_docs(-4),
					["<C-f>"] = cmp.mapping.scroll_docs(4),
					["<C-Space>"] = cmp.mapping.complete(),
					["<C-e>"] = cmp.mapping.abort(),
					["<CR>"] = cmp.mapping.confirm({ select = true }),
				}),
				sources = cmp.config.sources({
					{ name = "nvim_lsp" },
					{ name = "luasnip" },
					-- { name = "supermaven" },
				}, {
					{ name = "buffer" },
				}),
			})
			local function enter_or_indent_tag()
				local line = vim.fn.getline(".")
				local col = vim.fn.col(".")
				local before = line:sub(col - 1, col - 1)
				local after = line:sub(col, col)
				if before == ">" and after == "<" then
					return "<CR><C-o>O"
				end
				return "<CR>"
			end
			vim.api.nvim_create_autocmd("FileType", {
				pattern = "eruby",
				callback = function()
					vim.keymap.set("i", "<CR>", enter_or_indent_tag, { buffer = true, expr = true })
				end,
			})
		end,
	},
}
